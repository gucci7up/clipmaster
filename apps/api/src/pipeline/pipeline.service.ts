import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import {
  AspectRatio,
  AssetKind,
  CaptureStatus,
  ClipStatus,
  JobStatus,
  JobType,
  Prisma,
  Project,
  ProjectStatus,
} from '@prisma/client';
import {
  AnalyzeJobData,
  AnalyzeResult,
  AnyJobData,
  CopyJobData,
  CopyResult,
  ThumbnailJobData,
  ThumbnailResult,
  ThumbnailStyle,
  DEFAULT_SUBTITLE_STYLE,
  DEFAULT_THUMBNAIL_STYLE,
  ImportResult,
  LiveCaptureResult,
  MediaSource,
  MODES,
  ProgressEvent,
  Queues,
  QueueName,
  RenderAI,
  RenderJobData,
  RenderResult,
  SegmentReadyEvent,
  SignalWeights,
  SubtitleStyle,
  ProviderId,
} from '@clipmaster/shared';
import { AGENT_QUEUE, usesAgent, WAITING_STAGE } from '../agents/agents.service';
import { PrismaService } from '../common/prisma.service';
import { prefixFor } from '../common/storage.service';
import { env } from '../config/env';
import { EventsService } from '../events/events.service';
import { QueueService } from './queue.service';
import { selectClips, wordsInRange } from './selection';
import { asOverride, asRanges, effectiveWords } from '../clips/words';

export const TERMINAL_PROJECT: ProjectStatus[] = [ProjectStatus.COMPLETED, ProjectStatus.FAILED, ProjectStatus.CANCELLED];
const ACTIVE_JOB: JobStatus[] = [JobStatus.QUEUED, JobStatus.RUNNING];

/** Etapa reportada por el worker → estado visible del proyecto. */
const STAGE_TO_STATUS: Record<string, ProjectStatus> = {
  validate: ProjectStatus.VALIDATING,
  download: ProjectStatus.DOWNLOADING,
  import: ProjectStatus.DOWNLOADING,
  capture: ProjectStatus.CAPTURING,
  audio: ProjectStatus.TRANSCRIBING,
  transcribe: ProjectStatus.TRANSCRIBING,
  audio_analysis: ProjectStatus.ANALYZING,
  visual_analysis: ProjectStatus.ANALYZING,
  semantic: ProjectStatus.ANALYZING,
  scoring: ProjectStatus.ANALYZING,
  render: ProjectStatus.GENERATING,
};

const TYPE_QUEUE: Record<JobType, QueueName> = {
  IMPORT: Queues.CAPTURE,
  LIVE_CAPTURE: Queues.CAPTURE,
  ANALYZE: Queues.AI,
  RENDER: Queues.RENDER,
  CLEANUP: Queues.CAPTURE,
  COPY: Queues.AI,
  THUMBNAIL: Queues.RENDER,
};

/** Jobs de un clip que no forman parte del procesamiento del proyecto (no cambian su estado). */
const SIDE_JOBS: JobType[] = [JobType.COPY, JobType.THUMBNAIL];

type JobRow = Prisma.ProcessingJobGetPayload<{ include: { project: true } }>;

/**
 * Orquestador del pipeline: máquina de estados del proyecto, creación idempotente de jobs y
 * procesamiento de los resultados que los workers envían por la API interna.
 */
@Injectable()
export class PipelineService {
  private readonly log = new Logger(PipelineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
    private readonly events: EventsService,
  ) {}

  // ---------------------------------------------------------------- creación de jobs

  /**
   * Crea la fila ProcessingJob (dedupeKey única) y la encola en BullMQ con jobId = id de la fila.
   * Si ya existe un job con la misma clave, no se duplica. Los jobs de la cola del capturador remoto
   * sólo viven en PostgreSQL: el capturador los toma por HTTPS (ver AgentsService.claim).
   */
  async createJob(project: Pick<Project, 'id'>, type: JobType, dedupeKey: string, build: (jobId: string) => AnyJobData, queueOverride?: string) {
    const existing = await this.prisma.processingJob.findUnique({ where: { dedupeKey } });
    if (existing) return existing;
    const queue = queueOverride ?? TYPE_QUEUE[type];
    const remote = queue === AGENT_QUEUE;
    let row;
    try {
      row = await this.prisma.processingJob.create({
        data: { projectId: project.id, type, queue, dedupeKey, payload: {}, stage: remote ? WAITING_STAGE : null },
      });
    } catch (err) {
      if ((err as Prisma.PrismaClientKnownRequestError).code === 'P2002') {
        return this.prisma.processingJob.findUniqueOrThrow({ where: { dedupeKey } });
      }
      throw err;
    }
    const data = build(row.id);
    row = await this.prisma.processingJob.update({ where: { id: row.id }, data: { payload: data as unknown as Prisma.InputJsonValue } });
    if (!remote) await this.queues.enqueue(queue as QueueName, data);
    return row;
  }

  async startImport(project: Project, source: { type: 'upload'; storageKey: string } | { type: 'url'; url: string; provider: ProviderId }) {
    await this.prisma.project.update({
      where: { id: project.id },
      data: { status: source.type === 'url' ? ProjectStatus.VALIDATING : ProjectStatus.DOWNLOADING, startedAt: new Date(), errorMessage: null },
    });
    const remote = source.type === 'url' && usesAgent(source.provider);
    await this.createJob(project, JobType.IMPORT, `import:${project.id}`, (jobId) => ({
      kind: 'import',
      jobId,
      projectId: project.id,
      userId: project.userId,
      source,
      outputPrefix: prefixFor('originals', project.userId, project.id),
      maxDurationSec: env().MAX_VIDEO_DURATION_SEC,
    }), remote ? AGENT_QUEUE : undefined);
    await this.emitProject(project, 'project.started', {
      message: remote ? 'Esperando al capturador de tu PC para descargar el enlace' : 'Procesamiento iniciado',
    });
  }

  async startLive(project: Project, url: string, provider: ProviderId) {
    const capture = await this.prisma.captureSession.create({
      data: { projectId: project.id, segmentSeconds: env().LIVE_SEGMENT_SECONDS },
    });
    await this.prisma.project.update({
      where: { id: project.id },
      data: { status: ProjectStatus.CAPTURING, startedAt: new Date(), errorMessage: null },
    });
    await this.createJob(project, JobType.LIVE_CAPTURE, `live:${capture.id}`, (jobId) => ({
      kind: 'live',
      jobId,
      projectId: project.id,
      userId: project.userId,
      captureSessionId: capture.id,
      url,
      provider,
      segmentSeconds: capture.segmentSeconds,
      maxDurationSec: env().MAX_LIVE_DURATION_SEC,
      startIndex: 0,
      startOffsetSec: 0,
      outputPrefix: prefixFor('segments', project.userId, project.id),
    }));
    await this.emitProject(project, 'capture.started', { message: 'Captura del directo iniciada' });
    return capture;
  }

  private async analyzeSettings(project: Project) {
    const ai = await this.prisma.aISettings.findUnique({ where: { userId: project.userId } });
    const mode = MODES[project.mode];
    return {
      maxClips: project.maxClips,
      minDuration: project.minDuration,
      maxDuration: project.maxDuration,
      visualAnalysis: project.smartDetection && mode.visual && (ai?.visualAnalysis ?? true),
      semanticLLM: project.smartDetection && (ai?.semanticLLM ?? false),
      visionLLM: project.smartDetection && (ai?.semanticLLM ?? false) && (ai?.visionLLM ?? false),
      weights: (ai?.weights as SignalWeights | null) ?? undefined,
      preference: (project.preference as 'balanced' | 'quality' | 'quantity') ?? 'balanced',
    };
  }

  async enqueueAnalyze(project: Project, sources: MediaSource[], window: { start: number; end: number }, focus: { start: number; end: number }, segmentId: string | null, dedupeKey: string) {
    const settings = await this.analyzeSettings(project);
    return this.createJob(project, JobType.ANALYZE, dedupeKey, (jobId): AnalyzeJobData => ({
      kind: 'analyze',
      jobId,
      projectId: project.id,
      userId: project.userId,
      sources,
      window,
      focus,
      language: project.language,
      mode: project.mode,
      settings,
      outputPrefix: prefixFor('analysis', project.userId, project.id),
      segmentId,
    }));
  }

  /** Crea un ClipRender y su job de render con las palabras del rango para los subtítulos. */
  async enqueueRender(clipId: string) {
    const clip = await this.prisma.clip.findUniqueOrThrow({ where: { id: clipId }, include: { project: true } });
    const project = clip.project;
    const sources = await this.sourcesFor(project.id, clip.start, clip.end);
    if (!sources.length) throw new BadRequestException('No hay video fuente disponible para este rango');
    const ranges = asRanges(clip.segments);
    const style: SubtitleStyle = { ...DEFAULT_SUBTITLE_STYLE, ...((clip.subtitleStyle as Partial<SubtitleStyle>) ?? {}) };
    // Fuente propia: el render la descarga y libass la encuentra por su nombre de familia.
    const fonts: { key: string; family: string }[] = [];
    const custom = /^custom:([0-9a-f-]{36})$/.exec(style.font ?? '');
    if (custom) {
      const font = await this.prisma.userFont.findFirst({ where: { id: custom[1], userId: project.userId } });
      if (font) fonts.push({ key: font.storageKey, family: font.family });
      style.font = font?.family ?? DEFAULT_SUBTITLE_STYLE.font;
    }
    const segs = await this.prisma.transcriptSegment.findMany({
      where: { projectId: project.id, end: { gt: clip.start }, start: { lt: clip.end } },
      orderBy: { start: 'asc' },
    });
    const ai = await this.renderAi(project.userId, clip);
    const render = await this.prisma.clipRender.create({
      data: { clipId: clip.id, start: clip.start, end: clip.end, aspect: clip.aspect, status: ClipStatus.PENDING },
    });
    await this.prisma.clip.update({ where: { id: clip.id }, data: { status: ClipStatus.RENDERING } });
    await this.createJob(project, JobType.RENDER, `render:${clip.id}:${render.id}`, (jobId): RenderJobData => ({
      kind: 'render',
      jobId,
      projectId: project.id,
      userId: project.userId,
      clipId: clip.id,
      renderId: render.id,
      sources,
      start: clip.start,
      end: clip.end,
      aspect: clip.aspect,
      subtitles: {
        enabled: clip.subtitles,
        style,
        words: effectiveWords(wordsInRange(segs, clip.start, clip.end), asOverride(clip.wordOverride), ranges ?? [{ start: clip.start, end: clip.end }]),
      },
      hook: clip.hookEnabled ? { text: (clip.hookText || clip.title).slice(0, 120), durationSec: clip.hookDuration } : null,
      fonts,
      segments: ranges,
      ai,
      reframe: {
        mode: (clip.reframeMode as 'auto' | 'center' | 'manual') ?? 'auto',
        manualX: clip.manualX ?? undefined,
        manualY: clip.manualY ?? undefined,
      },
      track: null,
      outputPrefix: prefixFor('clips', project.userId, project.id),
    }));
    return render;
  }

  /** Funciones de NVIDIA del clip; null si el usuario no las activó o el clip no pide ninguna. */
  private async renderAi(userId: string, clip: { aiEyeContact: boolean; aiRelight: number | null; hookVoice: string | null; hookEnabled: boolean; coverPrompt: string | null }): Promise<RenderAI | null> {
    const settings = await this.prisma.aISettings.findUnique({ where: { userId } });
    if (!settings?.aiMedia) return null;
    const ai: RenderAI = {
      eyeContact: clip.aiEyeContact,
      relight: clip.aiRelight,
      hookVoice: clip.hookEnabled ? clip.hookVoice : null,
      coverPrompt: clip.coverPrompt,
    };
    return ai.eyeContact || ai.relight != null || ai.hookVoice || ai.coverPrompt ? ai : null;
  }

  /** Archivos fuente que cubren [start, end]: el original (VOD) o los segmentos del directo. */
  async sourcesFor(projectId: string, start: number, end: number): Promise<MediaSource[]> {
    const asset = await this.prisma.videoAsset.findFirst({ where: { projectId }, orderBy: { createdAt: 'desc' } });
    if (asset) return [{ key: asset.storageKey, offsetSec: 0, durationSec: asset.durationSec }];
    const segments = await this.prisma.videoSegment.findMany({ where: { projectId }, orderBy: { startSec: 'asc' } });
    return segments
      .filter((s) => s.startSec < end && s.startSec + s.durationSec > start)
      .map((s) => ({ key: s.storageKey, offsetSec: s.startSec, durationSec: s.durationSec }));
  }

  // ---------------------------------------------------------------- mensajes de workers

  async getJobRow(jobId: string): Promise<JobRow | null> {
    return this.prisma.processingJob.findUnique({ where: { id: jobId }, include: { project: true } });
  }

  /** El worker pregunta si debe procesar (idempotencia ante entregas repetidas). */
  async onStart(jobId: string) {
    const job = await this.getJobRow(jobId);
    if (!job) return { proceed: false, reason: 'unknown_job' };
    if (job.status === JobStatus.COMPLETED || job.status === JobStatus.CANCELLED) return { proceed: false, reason: job.status.toLowerCase() };
    if (job.project.status === ProjectStatus.CANCELLED || job.project.deletedAt) return { proceed: false, reason: 'project_cancelled' };
    await this.prisma.processingJob.update({
      where: { id: jobId },
      data: { status: JobStatus.RUNNING, startedAt: job.startedAt ?? new Date(), attempts: { increment: 1 } },
    });
    let resume: { startIndex: number; startOffsetSec: number } | undefined;
    if (job.type === JobType.LIVE_CAPTURE) {
      const payload = job.payload as { captureSessionId: string };
      const last = await this.prisma.videoSegment.findFirst({
        where: { captureSessionId: payload.captureSessionId },
        orderBy: { index: 'desc' },
      });
      resume = last ? { startIndex: last.index + 1, startOffsetSec: last.startSec + last.durationSec } : { startIndex: 0, startOffsetSec: 0 };
      await this.prisma.captureSession.update({ where: { id: payload.captureSessionId }, data: { status: CaptureStatus.RECORDING } });
    }
    return { proceed: true, resume };
  }

  async onProgress(ev: ProgressEvent) {
    const job = await this.getJobRow(ev.jobId);
    if (!job || job.status === JobStatus.COMPLETED || job.status === JobStatus.CANCELLED) return;
    const progress = ev.progress == null ? null : Math.max(0, Math.min(1, ev.progress));
    await this.prisma.processingJob.update({
      where: { id: job.id },
      data: { status: JobStatus.RUNNING, stage: ev.stage, progress },
    });
    const project = job.project;
    let status = STAGE_TO_STATUS[ev.stage];
    // Durante un directo el proyecto permanece en CAPTURING aunque se analicen segmentos.
    if (status && job.type !== JobType.LIVE_CAPTURE && (await this.isCapturing(project.id))) status = ProjectStatus.CAPTURING;
    if (job.type === JobType.RENDER) status = ProjectStatus.GENERATING;
    if (status && status !== project.status && !TERMINAL_PROJECT.includes(project.status)) {
      await this.prisma.project.update({ where: { id: project.id }, data: { status } });
    }
    if (job.type === JobType.LIVE_CAPTURE && ev.stage === 'reconnecting') {
      const p = job.payload as { captureSessionId: string };
      await this.prisma.captureSession.update({
        where: { id: p.captureSessionId },
        data: { status: CaptureStatus.RECONNECTING, reconnects: { increment: 1 } },
      });
    }
    await this.events.emit(
      { userId: project.userId, projectId: project.id, jobId: job.id, type: 'job.progress', stage: ev.stage, progress, message: ev.message ?? null, data: { jobType: job.type, status: status ?? project.status, metrics: ev.metrics } },
      // Sólo se persisten cambios de etapa para no inflar el historial.
      ev.stage !== job.stage,
    );
  }

  async onSegment(ev: SegmentReadyEvent) {
    const job = await this.getJobRow(ev.jobId);
    if (!job || job.type !== JobType.LIVE_CAPTURE) throw new BadRequestException('Job de captura desconocido');
    const project = job.project;
    let segment = await this.prisma.videoSegment.findUnique({
      where: { captureSessionId_index: { captureSessionId: ev.captureSessionId, index: ev.index } },
    });
    if (!segment) {
      segment = await this.prisma.videoSegment.create({
        data: {
          projectId: project.id,
          captureSessionId: ev.captureSessionId,
          index: ev.index,
          storageKey: ev.key,
          startSec: ev.startSec,
          durationSec: ev.durationSec,
          sizeBytes: BigInt(ev.sizeBytes),
        },
      });
      await this.trackAsset(project.userId, project.id, AssetKind.SEGMENT, ev.key, ev.sizeBytes, 'video/mp4');
      await this.prisma.captureSession.update({
        where: { id: ev.captureSessionId },
        data: { segmentsCount: { increment: 1 }, durationSec: ev.startSec + ev.durationSec, status: CaptureStatus.RECORDING },
      });
    }
    if (project.status === ProjectStatus.CANCELLED) return { segmentId: segment.id };

    // Ventana con contexto del segmento anterior para no perder reacciones entre cortes.
    const prev = await this.prisma.videoSegment.findFirst({
      where: { captureSessionId: ev.captureSessionId, index: ev.index - 1 },
    });
    const ctx = env().LIVE_CONTEXT_SECONDS;
    const sources: MediaSource[] = [];
    if (prev) sources.push({ key: prev.storageKey, offsetSec: prev.startSec, durationSec: prev.durationSec });
    sources.push({ key: segment.storageKey, offsetSec: segment.startSec, durationSec: segment.durationSec });
    const segEnd = segment.startSec + segment.durationSec;
    const windowStart = prev ? Math.max(prev.startSec, segment.startSec - ctx) : segment.startSec;
    await this.enqueueAnalyze(
      project,
      sources,
      { start: windowStart, end: segEnd },
      { start: segment.startSec, end: segEnd },
      segment.id,
      `analyze:segment:${segment.id}`,
    );
    await this.events.emit({
      userId: project.userId, projectId: project.id, jobId: job.id, type: 'capture.segment',
      message: `Segmento ${ev.index + 1} capturado`, data: { index: ev.index, startSec: ev.startSec, durationSec: ev.durationSec },
    });
    return { segmentId: segment.id };
  }

  async onComplete(jobId: string, result: unknown) {
    const job = await this.getJobRow(jobId);
    if (!job) throw new BadRequestException('Job desconocido');
    if (job.status === JobStatus.COMPLETED) return { duplicate: true };
    if (job.status === JobStatus.CANCELLED) return { cancelled: true };

    switch (job.type) {
      case JobType.IMPORT:
        await this.completeImport(job, result as ImportResult);
        break;
      case JobType.ANALYZE:
        await this.completeAnalyze(job, result as AnalyzeResult);
        break;
      case JobType.RENDER:
        await this.completeRender(job, result as RenderResult);
        break;
      case JobType.LIVE_CAPTURE:
        await this.completeLive(job, result as LiveCaptureResult);
        break;
      case JobType.COPY:
        await this.completeCopy(job, result as CopyResult);
        break;
      case JobType.THUMBNAIL:
        await this.completeThumbnail(job, result as ThumbnailResult);
        break;
      default:
        break;
    }
    await this.prisma.processingJob.update({
      where: { id: job.id },
      data: { status: JobStatus.COMPLETED, finishedAt: new Date(), progress: 1, result: summarize(result) },
    });
    if (!SIDE_JOBS.includes(job.type)) await this.checkCompletion(job.projectId);
    return { ok: true };
  }

  async onFail(jobId: string, error: string, willRetry: boolean, attempt: number) {
    const job = await this.getJobRow(jobId);
    if (!job || job.status === JobStatus.COMPLETED || job.status === JobStatus.CANCELLED) return;
    const history = Array.isArray(job.errorHistory) ? (job.errorHistory as unknown[]) : [];
    history.push({ at: new Date().toISOString(), attempt, error: error.slice(0, 2000) });
    await this.prisma.processingJob.update({
      where: { id: job.id },
      data: {
        status: willRetry ? JobStatus.QUEUED : JobStatus.FAILED,
        error: error.slice(0, 2000),
        errorHistory: history as Prisma.InputJsonValue,
        finishedAt: willRetry ? null : new Date(),
      },
    });
    const project = job.project;
    await this.events.emit({
      userId: project.userId, projectId: project.id, jobId: job.id,
      type: willRetry ? 'job.retry' : 'job.failed',
      message: willRetry ? `Reintentando (${attempt}): ${error}` : error,
      data: { jobType: job.type },
    });
    if (willRetry) return;

    if (job.type === JobType.COPY) {
      const p = job.payload as unknown as CopyJobData;
      await this.prisma.clip.update({ where: { id: p.clipId }, data: { socialStatus: 'FAILED', socialError: error.slice(0, 500) } }).catch(() => undefined);
      return;
    }
    if (job.type === JobType.THUMBNAIL) {
      const p = job.payload as unknown as ThumbnailJobData;
      await this.prisma.clip.update({ where: { id: p.clipId }, data: { thumbStatus: 'FAILED', thumbError: error.slice(0, 500) } }).catch(() => undefined);
      return;
    }
    if (job.type === JobType.RENDER) {
      const p = job.payload as unknown as RenderJobData;
      await this.prisma.clipRender.update({ where: { id: p.renderId }, data: { status: ClipStatus.FAILED, error: error.slice(0, 2000), finishedAt: new Date() } }).catch(() => undefined);
      const clip = await this.prisma.clip.findUnique({ where: { id: p.clipId } });
      // Si había un render previo válido, el clip sigue disponible.
      if (clip) await this.prisma.clip.update({ where: { id: clip.id }, data: { status: clip.currentRenderId ? ClipStatus.READY : ClipStatus.FAILED } });
    } else if (job.type === JobType.LIVE_CAPTURE) {
      const p = job.payload as { captureSessionId: string };
      await this.prisma.captureSession.update({ where: { id: p.captureSessionId }, data: { status: CaptureStatus.FAILED, endedAt: new Date(), endedReason: error.slice(0, 500) } });
    } else if (job.type === JobType.ANALYZE && (job.payload as { segmentId?: string }).segmentId) {
      // Un segmento fallido de un directo no detiene el resto.
    } else {
      await this.failProject(project.id, error);
      return;
    }
    await this.checkCompletion(project.id);
  }

  // ---------------------------------------------------------------- resultados

  private async completeThumbnail(job: JobRow, r: ThumbnailResult) {
    const p = job.payload as unknown as ThumbnailJobData;
    const clip = await this.prisma.clip.findUnique({ where: { id: p.clipId } });
    if (!clip) return;
    await this.prisma.clip.update({ where: { id: clip.id }, data: { thumbKey: r.key, thumbStatus: 'READY', thumbError: null } });
    await this.trackAsset(job.project.userId, job.projectId, AssetKind.THUMBNAIL, r.key, 0, 'image/jpeg');
    // La miniatura anterior deja de usarse: la limpieza la borrará.
    if (clip.thumbKey && clip.thumbKey !== r.key) {
      await this.prisma.storageAsset.updateMany({ where: { key: clip.thumbKey }, data: { temporary: true, expiresAt: new Date() } });
    }
  }

  /** Encola la miniatura de un clip. `at` es relativo al clip (en los combinados, a su línea de tiempo). */
  /**
   * Miniatura/portada del clip. `prompt` es lo que escribió el usuario (se guarda tal cual en thumbConfig);
   * `jobPrompt` es el que se envía a FLUX (el del usuario o uno hecho con los datos del clip).
   */
  async enqueueThumbnail(clipId: string, input: {
    at: number; aspect: AspectRatio; background: 'frame' | 'ai'; cutout: boolean; prompt: string | null; jobPrompt?: string | null;
    text: string; style: ThumbnailStyle;
  }) {
    const { jobPrompt, ...config } = input;
    const clip = await this.prisma.clip.findUniqueOrThrow({ where: { id: clipId }, include: { project: true } });
    const project = clip.project;
    const ranges = asRanges(clip.segments) ?? [{ start: clip.start, end: clip.end }];
    let rest = Math.max(0, input.at);
    let at = ranges[ranges.length - 1].end - 0.05;
    for (const r of ranges) {
      if (rest < r.end - r.start) { at = r.start + rest; break; }
      rest -= r.end - r.start;
    }
    const sources = await this.sourcesFor(project.id, at, at + 0.1);
    if (!sources.length) throw new BadRequestException('No hay video fuente disponible para ese instante');
    const style = { ...input.style };
    const fonts: { key: string; family: string }[] = [];
    const custom = /^custom:([0-9a-f-]{36})$/.exec(style.font);
    if (custom) {
      const font = await this.prisma.userFont.findFirst({ where: { id: custom[1], userId: project.userId } });
      if (font) fonts.push({ key: font.storageKey, family: font.family });
      style.font = font?.family ?? DEFAULT_THUMBNAIL_STYLE.font;
    }
    await this.prisma.clip.update({
      where: { id: clip.id },
      data: { thumbConfig: config as unknown as Prisma.InputJsonValue, thumbStatus: 'PENDING', thumbError: null },
    });
    return this.createJob(project, JobType.THUMBNAIL, `thumbnail:${clip.id}:${Date.now()}`, (jobId): ThumbnailJobData => ({
      kind: 'thumbnail', jobId, projectId: project.id, userId: project.userId, clipId: clip.id, sources, at,
      aspect: input.aspect, background: input.background, cutout: input.cutout, prompt: jobPrompt ?? input.prompt, text: input.text, style, fonts,
      reframe: { mode: clip.reframeMode as 'auto' | 'center' | 'manual', manualX: clip.manualX, manualY: clip.manualY },
      outputPrefix: prefixFor('thumbnails', project.userId, project.id),
    }));
  }

  private async completeCopy(job: JobRow, r: CopyResult) {
    const p = job.payload as unknown as CopyJobData;
    const copy = { title: r.title, description: r.description, hashtags: r.hashtags, model: r.model, generatedAt: new Date().toISOString() };
    await this.prisma.clip.update({
      where: { id: p.clipId },
      data: { socialCopy: copy as unknown as Prisma.InputJsonValue, socialStatus: 'READY', socialError: null },
    });
  }

  private async completeImport(job: JobRow, r: ImportResult) {
    const project = job.project;
    const a = r.asset;
    await this.prisma.videoAsset.upsert({
      where: { storageKey: a.key },
      create: {
        projectId: project.id, storageKey: a.key, sizeBytes: BigInt(a.sizeBytes), durationSec: a.durationSec,
        width: a.width, height: a.height, fps: a.fps, hasAudio: a.hasAudio, hasVideo: a.hasVideo,
        videoCodec: a.videoCodec, audioCodec: a.audioCodec, container: a.container,
      },
      update: {},
    });
    await this.trackAsset(project.userId, project.id, AssetKind.ORIGINAL, a.key, a.sizeBytes, 'video/mp4');
    if (r.title) await this.prisma.videoSource.updateMany({ where: { projectId: project.id, title: null }, data: { title: r.title.slice(0, 300) } });
    // La subida original ya no se necesita si se normalizó a otro objeto.
    const src = await this.prisma.videoSource.findUnique({ where: { projectId: project.id } });
    if (src?.uploadKey && src.uploadKey !== a.key) {
      await this.prisma.storageAsset.updateMany({ where: { key: src.uploadKey }, data: { temporary: true, expiresAt: new Date() } });
    }
    await this.prisma.project.update({ where: { id: project.id }, data: { status: ProjectStatus.TRANSCRIBING } });
    await this.events.emit({ userId: project.userId, projectId: project.id, jobId: job.id, type: 'import.completed', message: 'Video importado', data: { durationSec: a.durationSec, width: a.width, height: a.height } });
    await this.enqueueAnalyze(
      project,
      [{ key: a.key, offsetSec: 0, durationSec: a.durationSec }],
      { start: 0, end: a.durationSec },
      { start: 0, end: a.durationSec },
      null,
      `analyze:full:${project.id}`,
    );
  }

  private async completeAnalyze(job: JobRow, r: AnalyzeResult) {
    const project = job.project;
    const payload = job.payload as unknown as AnalyzeJobData;
    const isLiveSegment = Boolean(payload.segmentId);
    const focus = payload.focus;

    // Transcripción: en directos sólo se guardan los segmentos que empiezan dentro del foco (evita duplicar el contexto).
    const segs = r.segments.filter((s) => !isLiveSegment || (s.start >= focus.start && s.start < focus.end));
    await this.prisma.$transaction(async (tx) => {
      const transcript = await tx.transcript.create({
        data: {
          projectId: project.id, segmentId: payload.segmentId ?? null, language: r.language, model: r.model,
          storageKey: r.transcriptKey, srtKey: r.srtKey, windowStart: payload.window.start, windowEnd: payload.window.end,
        },
      });
      if (segs.length) {
        await tx.transcriptSegment.createMany({
          data: segs.map((s) => ({
            transcriptId: transcript.id, projectId: project.id, start: s.start, end: s.end,
            text: s.text, words: s.words as unknown as Prisma.InputJsonValue,
          })),
        });
      }
    });
    for (const key of [r.transcriptKey, r.srtKey]) {
      if (key) await this.trackAsset(project.userId, project.id, AssetKind.TRANSCRIPT, key, 0, 'application/json');
    }
    if (r.language && !project.detectedLanguage) {
      await this.prisma.project.update({ where: { id: project.id }, data: { detectedLanguage: r.language } });
    }
    if (payload.segmentId) await this.prisma.videoSegment.update({ where: { id: payload.segmentId }, data: { analyzed: true } });

    const created = await this.prisma.$transaction(
      r.candidates.map((c) =>
        this.prisma.highlightCandidate.create({
          data: {
            projectId: project.id, start: c.start, end: c.end, peakTime: c.peakTime, score: c.score,
            title: c.title.slice(0, 200), reason: c.reason.slice(0, 1000), text: c.text.slice(0, 5000),
            signals: c.signals as Prisma.InputJsonValue, tags: c.tags.slice(0, 20),
          },
        }),
      ),
    );

    const existing = await this.prisma.clip.findMany({ where: { projectId: project.id, deletedAt: null }, select: { start: true, end: true } });
    const selected = selectClips({
      candidates: r.candidates,
      existing,
      maxClips: project.maxClips,
      minScore: MODES[project.mode].minScore,
      preference: project.preference,
      allowFallback: !isLiveSegment,
    });
    const style = await this.userSubtitleStyle(project.userId);
    const hookTitles = (await this.prisma.userSettings.findUnique({ where: { userId: project.userId } }))?.hookTitles ?? true;
    for (const s of selected) {
      const idx = r.candidates.indexOf(s.candidate);
      const cand = created[idx];
      await this.prisma.highlightCandidate.update({ where: { id: cand.id }, data: { selected: true } });
      const clip = await this.prisma.clip.create({
        data: {
          projectId: project.id, candidateId: cand.id, title: s.candidate.title.slice(0, 200),
          reason: (s.lowConfidence ? '[Confianza baja] ' : '') + s.candidate.reason.slice(0, 1000),
          score: s.candidate.score, start: s.candidate.start, end: s.candidate.end, aspect: project.aspect,
          subtitles: project.subtitles, subtitleStyle: style as unknown as Prisma.InputJsonValue, hookEnabled: hookTitles,
        },
      });
      await this.enqueueRender(clip.id);
    }

    const capturing = await this.isCapturing(project.id);
    if (!capturing && selected.length > 0) {
      await this.prisma.project.update({ where: { id: project.id }, data: { status: ProjectStatus.GENERATING } });
    }
    await this.events.emit({
      userId: project.userId, projectId: project.id, jobId: job.id, type: 'analysis.completed',
      message: `${r.candidates.length} momentos detectados, ${selected.length} clips en generación`,
      data: { candidates: r.candidates.length, selected: selected.length, timings: r.timings, modules: r.modules, device: r.device },
    });
  }

  private async completeRender(job: JobRow, r: RenderResult) {
    const project = job.project;
    const payload = job.payload as unknown as RenderJobData;
    const render = await this.prisma.clipRender.findUnique({ where: { id: payload.renderId } });
    await this.prisma.clipRender.update({
      where: { id: payload.renderId },
      data: {
        status: ClipStatus.READY, outputKey: r.outputKey, thumbnailKey: r.thumbnailKey, sizeBytes: BigInt(r.sizeBytes),
        coverKey: r.coverKey ?? null, aiStatus: r.ai ? (r.ai as Prisma.InputJsonValue) : Prisma.DbNull,
        durationSec: r.durationSec, width: r.width, height: r.height, encoder: r.encoder, finishedAt: new Date(),
        renderMs: render ? Date.now() - render.createdAt.getTime() : null,
      },
    });
    const clip = await this.prisma.clip.findUnique({ where: { id: payload.clipId } });
    // Sólo el render más reciente se convierte en el actual.
    const latest = await this.prisma.clipRender.findFirst({ where: { clipId: payload.clipId }, orderBy: { createdAt: 'desc' } });
    if (clip && latest?.id === payload.renderId) {
      await this.prisma.clip.update({ where: { id: clip.id }, data: { status: ClipStatus.READY, currentRenderId: payload.renderId } });
    }
    await this.trackAsset(project.userId, project.id, AssetKind.CLIP, r.outputKey, r.sizeBytes, 'video/mp4');
    await this.trackAsset(project.userId, project.id, AssetKind.THUMBNAIL, r.thumbnailKey, 0, 'image/jpeg');
    if (r.coverKey) await this.trackAsset(project.userId, project.id, AssetKind.THUMBNAIL, r.coverKey, 0, 'image/jpeg');
    if (r.subtitleKey) {
      await this.trackAsset(project.userId, project.id, AssetKind.SUBTITLE, r.subtitleKey, 0, 'text/x-ssa');
      await this.prisma.subtitleTrack.create({ data: { clipId: payload.clipId, renderId: payload.renderId, format: 'ass', storageKey: r.subtitleKey } });
    }
    await this.events.emit({
      userId: project.userId, projectId: project.id, jobId: job.id, type: 'clip.ready',
      message: `Clip listo: ${clip?.title ?? ''}`, data: { clipId: payload.clipId, renderId: payload.renderId },
    });
  }

  private async completeLive(job: JobRow, r: LiveCaptureResult) {
    const p = job.payload as { captureSessionId: string };
    await this.prisma.captureSession.update({
      where: { id: p.captureSessionId },
      data: { status: CaptureStatus.ENDED, endedAt: new Date(), endedReason: r.endedReason },
    });
    await this.events.emit({
      userId: job.project.userId, projectId: job.projectId, jobId: job.id, type: 'capture.ended',
      message: `Captura finalizada (${r.endedReason}), ${r.segments} segmentos`, data: { ...r },
    });
  }

  // ---------------------------------------------------------------- estado del proyecto

  async isCapturing(projectId: string): Promise<boolean> {
    const n = await this.prisma.captureSession.count({
      where: { projectId, status: { in: [CaptureStatus.STARTING, CaptureStatus.RECORDING, CaptureStatus.RECONNECTING, CaptureStatus.STOPPING] } },
    });
    return n > 0;
  }

  /** Cierra el proyecto cuando ya no quedan jobs activos ni capturas en curso. */
  async checkCompletion(projectId: string) {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project || TERMINAL_PROJECT.includes(project.status)) return;
    const active = await this.prisma.processingJob.count({ where: { projectId, status: { in: ACTIVE_JOB } } });
    if (active > 0 || (await this.isCapturing(projectId))) return;
    const ready = await this.prisma.clip.count({ where: { projectId, status: ClipStatus.READY, deletedAt: null } });
    const total = await this.prisma.clip.count({ where: { projectId, deletedAt: null } });
    const failedCore = await this.prisma.processingJob.count({ where: { projectId, status: JobStatus.FAILED, type: { in: [JobType.IMPORT, JobType.ANALYZE] } } });
    const completedAt = new Date();
    const processingMs = project.startedAt ? completedAt.getTime() - project.startedAt.getTime() : 0;
    if (total > 0 && ready === 0) {
      await this.failProject(projectId, 'No se pudo generar ningún clip');
      return;
    }
    if (total === 0 && failedCore > 0) {
      await this.failProject(projectId, 'El análisis falló');
      return;
    }
    await this.prisma.project.update({
      where: { id: projectId },
      data: {
        status: ProjectStatus.COMPLETED, completedAt, processingMs,
        errorMessage: total === 0 ? 'No se detectaron momentos destacados con la configuración actual' : null,
      },
    });
    await this.emitProject(project, 'project.completed', { message: total === 0 ? 'Completado sin clips' : `Completado: ${ready} clips listos`, data: { ready, total, processingMs } });
  }

  async failProject(projectId: string, message: string) {
    const project = await this.prisma.project.update({
      where: { id: projectId },
      data: { status: ProjectStatus.FAILED, errorMessage: message.slice(0, 1000), completedAt: new Date() },
    });
    await this.emitProject(project, 'project.failed', { message });
  }

  async cancelProject(project: Project) {
    if (TERMINAL_PROJECT.includes(project.status)) throw new ConflictException('El proyecto ya terminó');
    await this.queues.signalCancel(project.id);
    const jobs = await this.prisma.processingJob.findMany({ where: { projectId: project.id, status: { in: ACTIVE_JOB } } });
    for (const j of jobs) {
      if (j.queue !== AGENT_QUEUE) await this.queues.removeIfPending(j.queue as QueueName, j.id).catch(() => undefined);
      if (j.type === JobType.LIVE_CAPTURE) await this.queues.signalStopCapture((j.payload as { captureSessionId: string }).captureSessionId);
    }
    await this.prisma.processingJob.updateMany({ where: { projectId: project.id, status: { in: ACTIVE_JOB } }, data: { status: JobStatus.CANCELLED, finishedAt: new Date() } });
    await this.prisma.captureSession.updateMany({
      where: { projectId: project.id, status: { notIn: [CaptureStatus.ENDED, CaptureStatus.FAILED] } },
      data: { status: CaptureStatus.ENDED, endedAt: new Date(), endedReason: 'cancelled' },
    });
    await this.prisma.clip.updateMany({ where: { projectId: project.id, status: { in: [ClipStatus.PENDING, ClipStatus.RENDERING] } }, data: { status: ClipStatus.FAILED } });
    await this.prisma.project.update({ where: { id: project.id }, data: { status: ProjectStatus.CANCELLED, completedAt: new Date() } });
    await this.emitProject(project, 'project.cancelled', { message: 'Procesamiento cancelado' });
  }

  async stopCapture(project: Project) {
    const captures = await this.prisma.captureSession.findMany({
      where: { projectId: project.id, status: { in: [CaptureStatus.STARTING, CaptureStatus.RECORDING, CaptureStatus.RECONNECTING] } },
    });
    if (!captures.length) throw new ConflictException('No hay una captura activa');
    for (const c of captures) {
      await this.queues.signalStopCapture(c.id);
      await this.prisma.captureSession.update({ where: { id: c.id }, data: { status: CaptureStatus.STOPPING } });
    }
    await this.emitProject(project, 'capture.stopping', { message: 'Deteniendo captura; se procesarán los segmentos pendientes' });
  }

  // ---------------------------------------------------------------- utilidades

  /** Estilo y título gancho que el usuario tiene por defecto para clips nuevos. */
  async clipDefaults(userId: string): Promise<{ style: SubtitleStyle; hookTitles: boolean }> {
    const hookTitles = (await this.prisma.userSettings.findUnique({ where: { userId } }))?.hookTitles ?? true;
    return { style: await this.userSubtitleStyle(userId), hookTitles };
  }

  private async userSubtitleStyle(userId: string): Promise<SubtitleStyle> {
    const s = await this.prisma.userSettings.findUnique({ where: { userId } });
    return { ...DEFAULT_SUBTITLE_STYLE, ...((s?.subtitleStyle as Partial<SubtitleStyle> | null) ?? {}) };
  }

  async trackAsset(userId: string, projectId: string, kind: AssetKind, key: string, sizeBytes: number, mimeType: string) {
    const existing = await this.prisma.storageAsset.findUnique({ where: { key } });
    if (existing) return existing;
    const [asset] = await this.prisma.$transaction([
      this.prisma.storageAsset.create({ data: { userId, projectId, kind, key, sizeBytes: BigInt(sizeBytes), mimeType } }),
      this.prisma.user.update({ where: { id: userId }, data: { storageUsedBytes: { increment: BigInt(sizeBytes) } } }),
    ]);
    return asset;
  }

  private async emitProject(project: Pick<Project, 'id' | 'userId'>, type: string, extra: { message?: string; data?: Record<string, unknown> }) {
    await this.events.emit({ userId: project.userId, projectId: project.id, type, message: extra.message, data: extra.data });
  }

  async clearCancel(projectId: string) {
    await this.queues.clearCancel(projectId);
  }
}

/** Guarda un resumen del resultado (sin transcripciones completas) en la fila del job. */
function summarize(result: unknown): Prisma.InputJsonValue {
  if (!result || typeof result !== 'object') return {};
  const r = { ...(result as Record<string, unknown>) };
  if (Array.isArray(r.segments)) r.segments = `${(r.segments as unknown[]).length} segmentos`;
  if (Array.isArray(r.candidates)) r.candidates = `${(r.candidates as unknown[]).length} candidatos`;
  return r as Prisma.InputJsonValue;
}
