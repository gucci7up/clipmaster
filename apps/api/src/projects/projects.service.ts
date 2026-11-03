import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { AssetKind, JobStatus, JobType, Project, ProjectStatus, Provider, SourceKind } from '@prisma/client';
import { createReadStream, promises as fs } from 'node:fs';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../common/prisma.service';
import { buildKey, prefixFor, StorageService } from '../common/storage.service';
import { toJSONSafe } from '../common/json';
import { env } from '../config/env';
import { MediaService } from '../media/media.service';
import { PipelineService, TERMINAL_PROJECT } from '../pipeline/pipeline.service';
import { SourcesService } from '../sources/sources.service';
import { CreateUrlProjectDto, ProjectOptionsDto } from './projects.dto';

export const VIDEO_EXTENSIONS = ['mp4', 'mov', 'm4v', 'webm', 'mkv'];

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly pipeline: PipelineService,
    private readonly sources: SourcesService,
    private readonly media: MediaService,
    private readonly audit: AuditService,
  ) {}

  async owned(userId: string, id: string): Promise<Project> {
    const p = await this.prisma.project.findFirst({ where: { id, userId, deletedAt: null } });
    if (!p) throw new NotFoundException('Proyecto no encontrado');
    return p;
  }

  private options(dto: ProjectOptionsDto) {
    return {
      name: dto.name.trim(),
      mode: dto.mode,
      language: dto.language ?? null,
      maxClips: dto.maxClips,
      minDuration: dto.minDuration,
      maxDuration: dto.maxDuration,
      aspect: dto.aspect,
      subtitles: dto.subtitles,
      smartDetection: dto.smartDetection,
      preference: dto.preference,
    };
  }

  private async assertCanStart(userId: string, incomingBytes = 0) {
    const active = await this.prisma.project.count({
      where: { userId, deletedAt: null, status: { notIn: TERMINAL_PROJECT } },
    });
    if (active >= env().MAX_ACTIVE_PROJECTS_PER_USER) {
      throw new HttpException(`Máximo ${env().MAX_ACTIVE_PROJECTS_PER_USER} procesamientos activos a la vez`, HttpStatus.TOO_MANY_REQUESTS);
    }
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (user.storageUsedBytes + BigInt(incomingBytes) > user.storageQuotaBytes) {
      throw new PayloadTooLargeException('Has superado tu cuota de almacenamiento');
    }
  }

  async createFromUpload(userId: string, dto: ProjectOptionsDto, file: Express.Multer.File, ip?: string) {
    try {
      const ext = (file.originalname.split('.').pop() ?? '').toLowerCase();
      if (!VIDEO_EXTENSIONS.includes(ext)) throw new BadRequestException(`Formato no admitido. Usa: ${VIDEO_EXTENSIONS.join(', ')}`);
      if (!(await looksLikeVideo(file.path))) throw new BadRequestException('El archivo no parece un video válido');
      await this.assertCanStart(userId, file.size);

      const project = await this.prisma.project.create({ data: { userId, ...this.options(dto) } });
      const key = buildKey('uploads', userId, project.id, ext);
      await this.storage.uploadStream(key, createReadStream(file.path), file.mimetype || 'video/mp4');
      await this.prisma.videoSource.create({
        data: { projectId: project.id, kind: SourceKind.UPLOAD, provider: Provider.UPLOAD, uploadKey: key, title: file.originalname.slice(0, 300) },
      });
      await this.pipeline.trackAsset(userId, project.id, AssetKind.UPLOAD, key, file.size, file.mimetype || 'video/mp4');
      await this.audit.log(userId, 'project.create_upload', project.id, ip, { size: file.size });
      await this.pipeline.startImport(project, { type: 'upload', storageKey: key });
      return this.detail(userId, project.id);
    } finally {
      await fs.rm(file.path, { force: true });
    }
  }

  async createFromUrl(userId: string, dto: CreateUrlProjectDto, ip?: string) {
    if (!dto.authorized) throw new BadRequestException('Debes confirmar que tienes derechos o autorización para procesar este contenido');
    const validation = await this.sources.validate(dto.url);
    if (!validation.ok || !validation.provider) throw new BadRequestException(validation.reason ?? 'La URL no se puede procesar');
    if (validation.isLive && !validation.supportsLive) {
      throw new BadRequestException(validation.reason ?? 'Este proveedor no permite capturar directos. Sube tu grabación.');
    }
    await this.assertCanStart(userId);
    const live = validation.isLive && dto.captureLive !== false;
    const project = await this.prisma.project.create({ data: { userId, ...this.options(dto) } });
    await this.prisma.videoSource.create({
      data: {
        projectId: project.id, kind: SourceKind.URL, provider: validation.provider as Provider, url: dto.url,
        isLive: live, title: validation.title?.slice(0, 300) ?? null,
        metadata: { durationSec: validation.durationSec, thumbnail: validation.thumbnail },
      },
    });
    await this.audit.log(userId, 'project.create_url', project.id, ip, { provider: validation.provider, live });
    if (live) await this.pipeline.startLive(project, dto.url, validation.provider);
    else await this.pipeline.startImport(project, { type: 'url', url: dto.url, provider: validation.provider });
    return this.detail(userId, project.id);
  }

  async list(userId: string, q: { status?: string; search?: string; page?: number; pageSize?: number }) {
    const page = Math.max(1, q.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, q.pageSize ?? 20));
    const where = {
      userId,
      deletedAt: null,
      ...(q.status && Object.values(ProjectStatus).includes(q.status as ProjectStatus) ? { status: q.status as ProjectStatus } : {}),
      ...(q.search ? { name: { contains: q.search, mode: 'insensitive' as const } } : {}),
    };
    const [total, items] = await Promise.all([
      this.prisma.project.count({ where }),
      this.prisma.project.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          source: true,
          _count: { select: { clips: { where: { deletedAt: null } } } },
          clips: {
            where: { deletedAt: null, currentRenderId: { not: null } },
            orderBy: { score: 'desc' },
            take: 1,
            select: { currentRenderId: true },
          },
        },
      }),
    ]);
    return toJSONSafe({
      total,
      page,
      pageSize,
      items: items.map(({ clips, _count, ...p }) => ({
        ...p,
        clipCount: _count.clips,
        thumbnailUrl: clips[0]?.currentRenderId ? this.media.url('thumb', clips[0].currentRenderId) : null,
      })),
    });
  }

  async detail(userId: string, id: string) {
    const p = await this.prisma.project.findFirst({
      where: { id, userId, deletedAt: null },
      include: {
        source: true,
        assets: { orderBy: { createdAt: 'desc' } },
        captures: { orderBy: { startedAt: 'desc' } },
        jobs: { orderBy: { queuedAt: 'asc' }, select: { id: true, type: true, status: true, stage: true, progress: true, attempts: true, error: true, queuedAt: true, startedAt: true, finishedAt: true } },
        _count: { select: { clips: { where: { deletedAt: null } }, candidates: true, segments: true } },
      },
    });
    if (!p) throw new NotFoundException('Proyecto no encontrado');
    const original = p.assets[0];
    return toJSONSafe({
      ...p,
      originalUrl: original ? this.media.url('original', original.id) : null,
    });
  }

  async events(userId: string, id: string, limit = 100) {
    await this.owned(userId, id);
    return this.prisma.processingEvent.findMany({ where: { projectId: id }, orderBy: { createdAt: 'desc' }, take: Math.min(500, limit) });
  }

  async transcript(userId: string, id: string) {
    await this.owned(userId, id);
    return this.prisma.transcriptSegment.findMany({
      where: { projectId: id },
      orderBy: { start: 'asc' },
      select: { id: true, start: true, end: true, text: true },
    });
  }

  async candidates(userId: string, id: string) {
    await this.owned(userId, id);
    return this.prisma.highlightCandidate.findMany({ where: { projectId: id }, orderBy: { score: 'desc' } });
  }

  async cancel(userId: string, id: string) {
    const p = await this.owned(userId, id);
    await this.pipeline.cancelProject(p);
    await this.audit.log(userId, 'project.cancel', id);
    return this.detail(userId, id);
  }

  async stopCapture(userId: string, id: string) {
    const p = await this.owned(userId, id);
    await this.pipeline.stopCapture(p);
    return this.detail(userId, id);
  }

  /** Reintenta un proyecto fallido/cancelado desde el paso que corresponda. */
  async retry(userId: string, id: string) {
    const p = await this.owned(userId, id);
    if (!(p.status === ProjectStatus.FAILED || p.status === ProjectStatus.CANCELLED)) {
      throw new ConflictException('Sólo se pueden reintentar proyectos fallidos o cancelados');
    }
    await this.pipeline.clearCancel(p.id);
    const source = await this.prisma.videoSource.findUnique({ where: { projectId: id } });
    const asset = await this.prisma.videoAsset.findFirst({ where: { projectId: id } });
    const updated = await this.prisma.project.update({ where: { id }, data: { status: ProjectStatus.PENDING, errorMessage: null, startedAt: new Date(), completedAt: null } });
    const suffix = Date.now().toString(36);
    if (asset) {
      await this.prisma.project.update({ where: { id }, data: { status: ProjectStatus.TRANSCRIBING } });
      await this.pipeline.enqueueAnalyze(updated, [{ key: asset.storageKey, offsetSec: 0, durationSec: asset.durationSec }], { start: 0, end: asset.durationSec }, { start: 0, end: asset.durationSec }, null, `analyze:full:${id}:${suffix}`);
    } else if (source?.kind === SourceKind.UPLOAD && source.uploadKey) {
      await this.prisma.project.update({ where: { id }, data: { status: ProjectStatus.DOWNLOADING } });
      await this.pipeline.createJob(updated, JobType.IMPORT, `import:${id}:${suffix}`, (jobId) => ({
        kind: 'import', jobId, projectId: id, userId, source: { type: 'upload', storageKey: source.uploadKey! },
        outputPrefix: prefixFor('originals', userId, id), maxDurationSec: env().MAX_VIDEO_DURATION_SEC,
      }));
    } else if (source?.url) {
      if (source.isLive) await this.pipeline.startLive(updated, source.url, source.provider);
      else {
        await this.prisma.project.update({ where: { id }, data: { status: ProjectStatus.VALIDATING } });
        await this.pipeline.createJob(updated, JobType.IMPORT, `import:${id}:${suffix}`, (jobId) => ({
          kind: 'import', jobId, projectId: id, userId, source: { type: 'url', url: source.url!, provider: source.provider },
          outputPrefix: prefixFor('originals', userId, id), maxDurationSec: env().MAX_VIDEO_DURATION_SEC,
        }));
      }
    } else {
      throw new BadRequestException('El proyecto no tiene una fuente reutilizable');
    }
    return this.detail(userId, id);
  }

  /**
   * Eliminación controlada: cancela trabajos, marca el proyecto como borrado y los objetos como
   * temporales caducados; el job de mantenimiento borra los archivos y ajusta la cuota.
   */
  async remove(userId: string, id: string) {
    const p = await this.owned(userId, id);
    if (!TERMINAL_PROJECT.includes(p.status)) await this.pipeline.cancelProject(p).catch(() => undefined);
    await this.prisma.$transaction([
      this.prisma.project.update({ where: { id }, data: { deletedAt: new Date() } }),
      this.prisma.storageAsset.updateMany({ where: { projectId: id, deletedAt: null }, data: { temporary: true, expiresAt: new Date() } }),
      this.prisma.processingJob.updateMany({ where: { projectId: id, status: { in: [JobStatus.QUEUED, JobStatus.RUNNING] } }, data: { status: JobStatus.CANCELLED } }),
    ]);
    await this.audit.log(userId, 'project.delete', id);
  }

  assertOwner(project: Project, userId: string) {
    if (project.userId !== userId) throw new ForbiddenException();
  }
}

/** Comprobación de "magic bytes" de contenedores de video comunes (ftyp, EBML, RIFF). */
export async function looksLikeVideo(path: string): Promise<boolean> {
  const fh = await fs.open(path, 'r');
  try {
    const buf = Buffer.alloc(12);
    await fh.read(buf, 0, 12, 0);
    if (buf.subarray(4, 8).toString('latin1') === 'ftyp') return true; // MP4/MOV/M4V
    if (buf.readUInt32BE(0) === 0x1a45dfa3) return true; // Matroska/WebM
    return false;
  } finally {
    await fh.close();
  }
}
