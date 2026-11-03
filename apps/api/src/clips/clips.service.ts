import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AspectRatio, ClipStatus, Prisma } from '@prisma/client';
import { BUILTIN_FONTS, DEFAULT_SUBTITLE_STYLE, SUBTITLE_PRESETS, SubtitleStyle, Word } from '@clipmaster/shared';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../common/prisma.service';
import { toJSONSafe } from '../common/json';
import { MediaService } from '../media/media.service';
import { PipelineService } from '../pipeline/pipeline.service';
import { wordsInRange } from '../pipeline/selection';
import { asOverride, asRanges, buildOverride, effectiveWords, Range } from './words';

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
  hookEnabled?: boolean;
  hookText?: string | null;
  hookDuration?: number;
}

const clipInclude = {
  renders: { orderBy: { createdAt: 'desc' as const }, take: 5 },
  project: { select: { id: true, name: true, userId: true, maxDuration: true, minDuration: true } },
  subtitleTracks: { orderBy: { createdAt: 'desc' as const }, take: 1 },
  candidate: { select: { signals: true, tags: true } },
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
    const { project, wordOverride, ...rest } = c;
    return toJSONSafe({
      ...rest,
      wordsEdited: Boolean(wordOverride),
      segments: asRanges(c.segments),
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
    const merged = asRanges(clip.segments);
    if (merged && ((input.start != null && input.start !== clip.start) || (input.end != null && input.end !== clip.end))) {
      throw new BadRequestException('Un clip combinado no se recorta: edita los clips originales y vuelve a combinarlos');
    }
    const start = input.start ?? clip.start;
    const end = input.end ?? clip.end;
    if (start < 0 || end <= start) throw new BadRequestException('Rango de tiempo inválido');
    if (end - start < 3) throw new BadRequestException('El clip debe durar al menos 3 segundos');
    if (!merged && end - start > 600) throw new BadRequestException('El clip no puede superar 10 minutos');
    if (input.subtitleStyle?.font) await this.assertFont(userId, input.subtitleStyle.font);
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
        hookEnabled: input.hookEnabled,
        hookText: input.hookText === undefined ? undefined : input.hookText?.replace(/\s+/g, ' ').trim().slice(0, 120) || null,
        hookDuration: input.hookDuration === undefined ? undefined : Math.max(1, Math.min(10, Number(input.hookDuration) || 3)),
      },
      include: clipInclude,
    });
    return this.serialize(updated);
  }

  /** Comprueba que una fuente `custom:<id>` es del usuario. */
  async assertFont(userId: string, font: string) {
    const m = /^custom:([0-9a-f-]{36})$/.exec(font);
    if (!m) return;
    const owned = await this.prisma.userFont.findFirst({ where: { id: m[1], userId } });
    if (!owned) throw new BadRequestException('Fuente no encontrada');
  }

  private ranges(clip: { start: number; end: number; segments: unknown }): Range[] {
    return asRanges(clip.segments) ?? [{ start: clip.start, end: clip.end }];
  }

  private async transcriptWords(projectId: string, ranges: Range[]): Promise<Word[]> {
    const lo = Math.min(...ranges.map((r) => r.start));
    const hi = Math.max(...ranges.map((r) => r.end));
    const segs = await this.prisma.transcriptSegment.findMany({
      where: { projectId, end: { gt: lo }, start: { lt: hi } },
      orderBy: { start: 'asc' },
    });
    return wordsInRange(segs, lo, hi);
  }

  /** Palabras del subtítulo del clip (con las correcciones del usuario) y las originales. */
  async words(userId: string, id: string) {
    const clip = await this.owned(userId, id);
    const ranges = this.ranges(clip);
    const original = effectiveWords(await this.transcriptWords(clip.projectId, ranges), null, ranges);
    const override = asOverride(clip.wordOverride);
    return { words: effectiveWords(original, override, ranges), original, edited: Boolean(override) };
  }

  /** Guarda el texto corregido de las palabras del clip (los tiempos no cambian). */
  async setWords(userId: string, id: string, edited: { start: number; end: number; word: string }[]) {
    const clip = await this.owned(userId, id);
    const ranges = this.ranges(clip);
    const original = effectiveWords(await this.transcriptWords(clip.projectId, ranges), null, ranges);
    const override = buildOverride(original, edited, ranges);
    await this.prisma.clip.update({ where: { id }, data: { wordOverride: override as unknown as Prisma.InputJsonValue } });
    await this.audit.log(userId, 'clip.words_edited', id);
    return this.words(userId, id);
  }

  async resetWords(userId: string, id: string) {
    await this.owned(userId, id);
    await this.prisma.clip.update({ where: { id }, data: { wordOverride: Prisma.DbNull } });
    return this.words(userId, id);
  }

  /** Crea un clip nuevo que encadena los tramos de varios clips del mismo proyecto (los originales no cambian). */
  async merge(userId: string, clipIds: string[], title?: string) {
    const unique = [...new Set(clipIds)];
    if (unique.length < 2 || unique.length > 10) throw new BadRequestException('Elige entre 2 y 10 clips');
    const clips = await Promise.all(unique.map((cid) => this.owned(userId, cid)));
    const projectId = clips[0].projectId;
    if (clips.some((c) => c.projectId !== projectId)) throw new BadRequestException('Los clips deben ser del mismo proyecto');
    const segments = clips.flatMap((c) => this.ranges(c));
    const total = segments.reduce((a, r) => a + (r.end - r.start), 0);
    if (total > 600) throw new BadRequestException('El clip combinado no puede superar 10 minutos');
    const lo = Math.min(...segments.map((r) => r.start));
    const hi = Math.max(...segments.map((r) => r.end));
    // Las correcciones de texto de los originales se conservan en el combinado.
    const transcript = await this.transcriptWords(projectId, segments);
    const edited = clips.some((c) => c.wordOverride);
    const words = clips.flatMap((c) => effectiveWords(transcript, asOverride(c.wordOverride), this.ranges(c)));
    const first = clips[0];
    const created = await this.prisma.clip.create({
      data: {
        projectId,
        title: (title?.trim() || clips.map((c) => c.title).join(' + ')).slice(0, 200),
        reason: `Combinación de ${clips.length} clips`,
        score: Math.max(...clips.map((c) => c.score)),
        start: lo,
        end: hi,
        segments: segments as unknown as Prisma.InputJsonValue,
        wordOverride: edited ? ({ start: lo, end: hi, words } as unknown as Prisma.InputJsonValue) : undefined,
        aspect: first.aspect,
        subtitles: first.subtitles,
        subtitleStyle: first.subtitleStyle as Prisma.InputJsonValue,
        reframeMode: first.reframeMode,
        manualX: first.manualX,
        manualY: first.manualY,
        hookEnabled: first.hookEnabled,
        hookText: first.hookText,
        hookDuration: first.hookDuration,
      },
    });
    await this.pipeline.enqueueRender(created.id);
    await this.audit.log(userId, 'clip.merge', created.id, null, { clipIds: unique });
    return this.detail(userId, created.id);
  }

  /** Aplica un estilo de subtítulos a todos los clips del proyecto y, si se pide, los vuelve a renderizar. */
  async applyStyleToProject(userId: string, projectId: string, style: Partial<SubtitleStyle>, regenerate: boolean) {
    const project = await this.prisma.project.findFirst({ where: { id: projectId, userId, deletedAt: null } });
    if (!project) throw new NotFoundException('Proyecto no encontrado');
    if (style.font) await this.assertFont(userId, style.font);
    const clean = { ...DEFAULT_SUBTITLE_STYLE, ...sanitizeStyle(style) };
    const clips = await this.prisma.clip.findMany({
      where: { projectId, deletedAt: null },
      include: { renders: { where: { status: { in: [ClipStatus.PENDING, ClipStatus.RENDERING] } }, take: 1 } },
    });
    await this.prisma.clip.updateMany({ where: { projectId, deletedAt: null }, data: { subtitleStyle: clean as unknown as Prisma.InputJsonValue } });
    let queued = 0;
    if (regenerate) {
      for (const c of clips) {
        if (c.renders.length) continue; // ya hay un render en curso; el estilo se usará en el siguiente
        await this.pipeline.enqueueRender(c.id);
        queued++;
      }
    }
    await this.audit.log(userId, 'project.style_applied', projectId, null, { clips: clips.length, queued });
    return { updated: clips.length, queued };
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
  if (s.preset && SUBTITLE_PRESETS.includes(s.preset)) out.preset = s.preset;
  if (typeof s.font === 'string' && ((BUILTIN_FONTS as readonly string[]).includes(s.font) || /^custom:[0-9a-f-]{36}$/.test(s.font))) out.font = s.font;
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
