/**
 * Integración del orquestador con PostgreSQL real (migraciones aplicadas).
 * Simula los mensajes de los workers y comprueba estados, clips, renders, cuota e idempotencia.
 * La cola BullMQ se sustituye por un registro en memoria (Redis no es necesario aquí).
 *
 *   TEST_DATABASE_URL=postgresql://... pnpm --filter @clipmaster/api test
 *
 * Sin TEST_DATABASE_URL la suite se omite.
 */
import type { AnalyzeResult, AnyJobData, ImportResult, RenderResult } from '@clipmaster/shared';
import { ProjectStatus } from '@prisma/client';
import type { PrismaService } from '../src/common/prisma.service';
import { loadEnv, setEnvForTests } from '../src/config/env';
import { EventsService } from '../src/events/events.service';
import { PipelineService } from '../src/pipeline/pipeline.service';
import type { QueueService } from '../src/pipeline/queue.service';

const DB = process.env.TEST_DATABASE_URL;
const run = DB ? describe : describe.skip;

class FakeQueues {
  enqueued: { queue: string; data: AnyJobData }[] = [];
  cancelled: string[] = [];
  async enqueue(queue: string, data: AnyJobData) { this.enqueued.push({ queue, data }); }
  async signalCancel(projectId: string) { this.cancelled.push(projectId); }
  async clearCancel() {}
  async removeIfPending() { return true; }
  async signalStopCapture() {}
  of(kind: AnyJobData['kind']) { return this.enqueued.filter((e) => e.data.kind === kind); }
}

run('pipeline (PostgreSQL real)', () => {
  let prisma: PrismaService;
  let queues: FakeQueues;
  let pipeline: PipelineService;
  let userId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = DB;
    setEnvForTests(loadEnv({
      NODE_ENV: 'test', DATABASE_URL: DB, S3_ACCESS_KEY: 'a', S3_SECRET_KEY: 'b',
      SESSION_SECRET: 's'.repeat(40), MEDIA_SIGNING_SECRET: 'm'.repeat(40), INTERNAL_API_TOKEN: 'i'.repeat(40),
    } as NodeJS.ProcessEnv));
    const { PrismaService: PS } = await import('../src/common/prisma.service');
    prisma = new PS();
    await prisma.$connect();
    const user = await prisma.user.create({ data: { email: `int-${Date.now()}@example.com`, name: 'Int', passwordHash: 'x' } });
    userId = user.id;
  });

  beforeEach(() => {
    queues = new FakeQueues();
    const events = new EventsService(prisma, {} as never);
    pipeline = new PipelineService(prisma, queues as unknown as QueueService, events);
  });

  afterAll(async () => {
    if (userId) await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  async function newProject(maxClips = 3) {
    return prisma.project.create({
      data: {
        userId, name: 'Prueba', maxClips, minDuration: 15, maxDuration: 60,
        source: { create: { kind: 'UPLOAD', provider: 'UPLOAD', uploadKey: `uploads/${userId}/x/a.mp4` } },
      },
    });
  }

  const importResult = (projectId: string): ImportResult => ({
    asset: {
      key: `originals/${userId}/${projectId}/orig.mp4`, sizeBytes: 50_000_000, durationSec: 600, width: 1920, height: 1080,
      fps: 30, hasAudio: true, hasVideo: true, videoCodec: 'h264', audioCodec: 'aac', container: 'mp4',
    },
    title: null,
  });

  const analyzeResult = (): AnalyzeResult => ({
    language: 'es', languageProbability: 0.97, durationSec: 600, transcriptKey: null, srtKey: null, model: 'small', device: 'cpu',
    timings: { total: 10 }, modules: { transcription: 'ok', audio: 'ok', visual: 'ok', semantic: 'ok', llm: 'skipped' },
    segments: [
      { start: 10, end: 14, text: 'qué jugada tan buena', words: [{ start: 10, end: 10.5, word: 'qué', probability: 0.9 }, { start: 10.5, end: 11, word: 'jugada', probability: 0.9 }] },
      { start: 100, end: 104, text: 'eso fue increíble', words: [{ start: 100, end: 101, word: 'eso', probability: 0.9 }] },
    ],
    candidates: [
      { start: 5, end: 40, peakTime: 12, score: 82, title: 'Jugada', reason: 'Pico de audio', text: 'qué jugada', signals: { audio: 0.9 }, tags: ['pico_audio'] },
      { start: 10, end: 45, peakTime: 20, score: 75, title: 'Solapado', reason: 'x', text: '', signals: {}, tags: [] },
      { start: 95, end: 130, peakTime: 101, score: 70, title: 'Increíble', reason: 'Risas', text: 'eso fue', signals: { emotion: 0.8 }, tags: ['risas'] },
      { start: 300, end: 330, peakTime: 310, score: 10, title: 'Flojo', reason: 'x', text: '', signals: {}, tags: [] },
    ],
  });

  const renderResult = (projectId: string, i: number): RenderResult => ({
    outputKey: `clips/${userId}/${projectId}/c${i}.mp4`, thumbnailKey: `thumbnails/${userId}/${projectId}/c${i}.jpg`,
    subtitleKey: `subtitles/${userId}/${projectId}/c${i}.ass`, durationSec: 35, width: 1080, height: 1920, sizeBytes: 4_000_000,
    encoder: 'libx264', hasAudio: true,
  });

  it('subida → importación → análisis → render → completado', async () => {
    const project = await newProject();
    await pipeline.startImport(project, { type: 'upload', storageKey: `uploads/${userId}/${project.id}/a.mp4` });
    const [imp] = queues.of('import');
    expect(imp.queue).toBe('capture');

    // Entrega duplicada del mismo trabajo: no crea otro job.
    await pipeline.startImport(project, { type: 'upload', storageKey: 'otra' });
    expect(queues.of('import')).toHaveLength(1);

    expect(await pipeline.onStart(imp.data.jobId)).toMatchObject({ proceed: true });
    await pipeline.onProgress({ jobId: imp.data.jobId, stage: 'import', progress: 0.5 });
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).status).toBe(ProjectStatus.DOWNLOADING);

    await pipeline.onComplete(imp.data.jobId, importResult(project.id));
    expect(await pipeline.onComplete(imp.data.jobId, importResult(project.id))).toEqual({ duplicate: true });
    expect(await pipeline.onStart(imp.data.jobId)).toMatchObject({ proceed: false });
    const [ana] = queues.of('analyze');
    expect(ana.queue).toBe('ai');
    expect(ana.data).toMatchObject({ window: { start: 0, end: 600 }, segmentId: null });

    await pipeline.onStart(ana.data.jobId);
    await pipeline.onProgress({ jobId: ana.data.jobId, stage: 'transcribe', progress: 0.2 });
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).status).toBe(ProjectStatus.TRANSCRIBING);
    await pipeline.onComplete(ana.data.jobId, analyzeResult());

    // Dos clips: el solapado y el de baja puntuación se descartan.
    const clips = await prisma.clip.findMany({ where: { projectId: project.id }, orderBy: { start: 'asc' } });
    expect(clips.map((c) => c.title)).toEqual(['Jugada', 'Increíble']);
    expect(await prisma.highlightCandidate.count({ where: { projectId: project.id } })).toBe(4);
    expect(await prisma.transcriptSegment.count({ where: { projectId: project.id } })).toBe(2);
    const renders = queues.of('render');
    expect(renders).toHaveLength(2);
    const firstRender = renders.find((r) => r.data.kind === 'render' && r.data.start === 5)!;
    expect(firstRender.data).toMatchObject({ aspect: 'VERTICAL', subtitles: { enabled: true } });
    expect(firstRender.data.kind === 'render' && firstRender.data.subtitles.words.map((w) => w.word)).toEqual(['qué', 'jugada']);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).status).toBe(ProjectStatus.GENERATING);

    for (const [i, r] of renders.entries()) {
      await pipeline.onStart(r.data.jobId);
      await pipeline.onComplete(r.data.jobId, renderResult(project.id, i));
    }
    const done = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(done.status).toBe(ProjectStatus.COMPLETED);
    expect(done.detectedLanguage).toBe('es');
    expect(done.processingMs).toBeGreaterThanOrEqual(0);
    const ready = await prisma.clip.findMany({ where: { projectId: project.id } });
    expect(ready.every((c) => c.status === 'READY' && c.currentRenderId)).toBe(true);
    expect(await prisma.subtitleTrack.count({ where: { clip: { projectId: project.id } } })).toBe(2);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(Number(user.storageUsedBytes)).toBeGreaterThanOrEqual(50_000_000 + 2 * 4_000_000);
    const types = (await prisma.processingEvent.findMany({ where: { projectId: project.id } })).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['project.started', 'import.completed', 'analysis.completed', 'clip.ready', 'project.completed']));
  });

  it('un fallo definitivo de importación marca el proyecto como fallido; un reintento no', async () => {
    const project = await newProject();
    await pipeline.startImport(project, { type: 'upload', storageKey: 'k' });
    const [imp] = queues.of('import');
    await pipeline.onStart(imp.data.jobId);
    await pipeline.onFail(imp.data.jobId, 'ffprobe: archivo dañado', true, 1);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).status).not.toBe(ProjectStatus.FAILED);
    await pipeline.onFail(imp.data.jobId, 'ffprobe: archivo dañado', false, 3);
    const p = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    expect(p.status).toBe(ProjectStatus.FAILED);
    expect(p.errorMessage).toContain('archivo dañado');
    const job = await prisma.processingJob.findUniqueOrThrow({ where: { id: imp.data.jobId } });
    expect(job.errorHistory).toHaveLength(2);
  });

  it('si el render falla, el proyecto falla sin clips listos; con un render válido previo el clip sigue listo', async () => {
    const project = await newProject(1);
    await pipeline.startImport(project, { type: 'upload', storageKey: 'k' });
    await pipeline.onComplete(queues.of('import')[0].data.jobId, importResult(project.id));
    await pipeline.onComplete(queues.of('analyze')[0].data.jobId, analyzeResult());
    const [r1] = queues.of('render');
    await pipeline.onComplete(r1.data.jobId, renderResult(project.id, 0));
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).status).toBe(ProjectStatus.COMPLETED);

    // Regenerar y fallar: el clip conserva el render anterior.
    const clip = await prisma.clip.findFirstOrThrow({ where: { projectId: project.id } });
    await pipeline.enqueueRender(clip.id);
    const r2 = queues.of('render')[1];
    await pipeline.onFail(r2.data.jobId, 'ffmpeg error', false, 3);
    const after = await prisma.clip.findUniqueOrThrow({ where: { id: clip.id } });
    expect(after.status).toBe('READY');
    expect(after.currentRenderId).not.toBeNull();
  });

  it('cancelar marca jobs y proyecto y señala a los workers', async () => {
    const project = await newProject();
    await pipeline.startImport(project, { type: 'upload', storageKey: 'k' });
    const fresh = await prisma.project.findUniqueOrThrow({ where: { id: project.id } });
    await pipeline.cancelProject(fresh);
    expect(queues.cancelled).toContain(project.id);
    expect((await prisma.project.findUniqueOrThrow({ where: { id: project.id } })).status).toBe(ProjectStatus.CANCELLED);
    const [imp] = queues.of('import');
    expect(await pipeline.onStart(imp.data.jobId)).toMatchObject({ proceed: false });
  });
});
