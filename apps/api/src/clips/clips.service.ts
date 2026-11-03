import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AspectRatio, ClipStatus, Prisma } from '@prisma/client';
import { DEFAULT_SUBTITLE_STYLE, SubtitleStyle } from '@clipmaster/shared';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../common/prisma.service';
import { toJSONSafe } from '../common/json';
import { MediaService } from '../media/media.service';
import { PipelineService } from '../pipeline/pipeline.service';

export interface UpdateClipInput {
  title?: string;
  start?: number;
  end?: number;
  aspect?: AspectRatio;
  subtitles?: boolean;
  subtitleStyle?: Partial<SubtitleStyle>;
  reframeMode?: 'auto' | 'center' | 'manual';
  manualX?: number | null;
  manualY?: number | null;
}

const clipInclude = {
  renders: { orderBy: { createdAt: 'desc' as const }, take: 5 },
  project: { select: { id: true, name: true, userId: true, maxDuration: true, minDuration: true } },
  subtitleTracks: { orderBy: { createdAt: 'desc' as const }, take: 1 },
} satisfies Prisma.ClipInclude;

type ClipWithRelations = Prisma.ClipGetPayload<{ include: typeof clipInclude }>;

@Injectable()
export class ClipsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pipeline: PipelineService,
    private readonly media: MediaService,
    private readonly audit: AuditService,
  ) {}

  private async owned(userId: string, id: string): Promise<ClipWithRelations> {
    const clip = await this.prisma.clip.findFirst({
      where: { id, deletedAt: null, project: { userId, deletedAt: null } },
      include: clipInclude,
    });
    if (!clip) throw new NotFoundException('Clip no encontrado');
    return clip;
  }

  serialize(c: ClipWithRelations | (Omit<ClipWithRelations, 'subtitleTracks'> & { subtitleTracks?: ClipWithRelations['subtitleTracks'] })) {
    const current = c.renders.find((r) => r.id === c.currentRenderId) ?? null;
    const { project, ...rest } = c;
    return toJSONSafe({
      ...rest,
      project: { id: project.id, name: project.name },
      duration: c.end - c.start,
      subtitleStyle: { ...DEFAULT_SUBTITLE_STYLE, ...((c.subtitleStyle as Partial<SubtitleStyle>) ?? {}) },
      videoUrl: current?.outputKey ? this.media.url('render', current.id) : null,
      downloadUrl: current?.outputKey ? this.media.url('render', current.id, { download: true }) : null,
      thumbnailUrl: current?.thumbnailKey ? this.media.url('thumb', current.id) : null,
      subtitleUrl: c.subtitleTracks?.[0] ? this.media.url('subtitle', c.subtitleTracks[0].id, { download: true }) : null,
      currentRender: current,
    });
  }

  async listForProject(userId: string, projectId: string) {
    const clips = await this.prisma.clip.findMany({
      where: { projectId, deletedAt: null, project: { userId, deletedAt: null } },
      orderBy: { score: 'desc' },
      include: clipInclude,
    });
    return clips.map((c) => this.serialize(c));
  }

  async listAll(userId: string, page = 1, pageSize = 24) {
    const where = { deletedAt: null, project: { userId, deletedAt: null } };
    const [total, clips] = await Promise.all([
      this.prisma.clip.count({ where }),
      this.prisma.clip.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize, include: clipInclude }),
    ]);
    return { total, page, pageSize, items: clips.map((c) => this.serialize(c)) };
  }

  async detail(userId: string, id: string) {
    return this.serialize(await this.owned(userId, id));
  }

  async update(userId: string, id: string, input: UpdateClipInput) {
    const clip = await this.owned(userId, id);
    const start = input.start ?? clip.start;
    const end = input.end ?? clip.end;
    if (start < 0 || end <= start) throw new BadRequestException('Rango de tiempo inválido');
    if (end - start < 3) throw new BadRequestException('El clip debe durar al menos 3 segundos');
    if (end - start > 600) throw new BadRequestException('El clip no puede superar 10 minutos');
    const sources = await this.pipeline.sourcesFor(clip.projectId, start, end);
    const coverageEnd = Math.max(0, ...sources.map((s) => s.offsetSec + s.durationSec));
    if (!sources.length || end > coverageEnd + 0.5) throw new BadRequestException('El rango excede la duración del video');
    const style = input.subtitleStyle
      ? { ...DEFAULT_SUBTITLE_STYLE, ...((clip.subtitleStyle as Partial<SubtitleStyle>) ?? {}), ...sanitizeStyle(input.subtitleStyle) }
      : undefined;
    const updated = await this.prisma.clip.update({
      where: { id },
      data: {
        title: input.title?.trim().slice(0, 200) || undefined,
        start,
        end,
        aspect: input.aspect,
        subtitles: input.subtitles,
        subtitleStyle: style as Prisma.InputJsonValue | undefined,
        reframeMode: input.reframeMode,
        manualX: input.manualX === undefined ? undefined : clamp01(input.manualX),
        manualY: input.manualY === undefined ? undefined : clamp01(input.manualY),
      },
      include: clipInclude,
    });
    return this.serialize(updated);
  }

  async regenerate(userId: string, id: string) {
    const clip = await this.owned(userId, id);
    const pendingRender = clip.renders.find((r) => r.status === ClipStatus.PENDING || r.status === ClipStatus.RENDERING);
    if (pendingRender) throw new ConflictException('Ya hay un render en curso para este clip');
    await this.pipeline.enqueueRender(clip.id);
    await this.audit.log(userId, 'clip.regenerate', id);
    return this.detail(userId, id);
  }

  async remove(userId: string, id: string) {
    const clip = await this.owned(userId, id);
    const keys = clip.renders.flatMap((r) => [r.outputKey, r.thumbnailKey]).filter((k): k is string => Boolean(k));
    await this.prisma.$transaction([
      this.prisma.clip.update({ where: { id }, data: { deletedAt: new Date() } }),
      this.prisma.storageAsset.updateMany({ where: { key: { in: keys } }, data: { temporary: true, expiresAt: new Date() } }),
    ]);
    await this.audit.log(userId, 'clip.delete', id);
  }
}

function clamp01(v: number | null): number | null {
  if (v === null) return null;
  return Math.max(0, Math.min(1, Number(v)));
}

const COLOR = /^#[0-9a-fA-F]{6}$/;
export function sanitizeStyle(s: Partial<SubtitleStyle>): Partial<SubtitleStyle> {
  const out: Partial<SubtitleStyle> = {};
  const num = (v: unknown, min: number, max: number, round = true): number | undefined => {
    const n = Number(v);
    if (v == null || v === '' || !Number.isFinite(n)) return undefined;
    return Math.max(min, Math.min(max, round ? Math.round(n) : n));
  };
  if (s.preset && ['tiktok', 'clean', 'karaoke'].includes(s.preset)) out.preset = s.preset;
  const fontSize = num(s.fontSize, 24, 160);
  if (fontSize !== undefined) out.fontSize = fontSize;
  for (const k of ['primaryColor', 'highlightColor', 'outlineColor'] as const) if (typeof s[k] === 'string' && COLOR.test(s[k])) out[k] = s[k];
  const outlineWidth = num(s.outlineWidth, 0, 12, false);
  if (outlineWidth !== undefined) out.outlineWidth = outlineWidth;
  if (s.position && ['bottom', 'center', 'top'].includes(s.position)) out.position = s.position;
  if (s.uppercase != null) out.uppercase = Boolean(s.uppercase);
  const maxWords = num(s.maxWordsPerLine, 1, 10);
  if (maxWords !== undefined) out.maxWordsPerLine = maxWords;
  return out;
}
