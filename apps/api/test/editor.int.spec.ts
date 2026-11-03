/**
 * Integración de las funciones del editor con PostgreSQL real: corrección de palabras, título gancho,
 * fuentes propias, estilos aplicados al proyecto y clips combinados. Se comprueba el trabajo de render
 * que recibiría el worker.
 *
 *   TEST_DATABASE_URL=postgresql://... pnpm --filter @clipmaster/api test
 */
import type { AnalyzeResult, AnyJobData, ImportResult, RenderJobData } from '@clipmaster/shared';
import { ClipsService } from '../src/clips/clips.service';
import type { AuditService } from '../src/common/audit.service';
import type { PrismaService } from '../src/common/prisma.service';
import { loadEnv, setEnvForTests } from '../src/config/env';
import { EventsService } from '../src/events/events.service';
import type { MediaService } from '../src/media/media.service';
import { PipelineService } from '../src/pipeline/pipeline.service';
import type { QueueService } from '../src/pipeline/queue.service';

const DB = process.env.TEST_DATABASE_URL;
const run = DB ? describe : describe.skip;

class FakeQueues {
  enqueued: { queue: string; data: AnyJobData }[] = [];
  async enqueue(queue: string, data: AnyJobData) { this.enqueued.push({ queue, data }); }
  async signalCancel() {}
  async clearCancel() {}
  async removeIfPending() { return true; }
  async signalStopCapture() {}
  renders() { return this.enqueued.filter((e) => e.data.kind === 'render').map((e) => e.data as RenderJobData); }
}

run('editor de clips (PostgreSQL real)', () => {
  let prisma: PrismaService;
  let queues: FakeQueues;
  let pipeline: PipelineService;
  let clips: ClipsService;
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
    userId = (await prisma.user.create({ data: { email: `editor-${Date.now()}@example.com`, name: 'Editor', passwordHash: 'x' } })).id;
  });

  beforeEach(() => {
    queues = new FakeQueues();
    pipeline = new PipelineService(prisma, queues as unknown as QueueService, new EventsService(prisma, {} as never));
    const media = { url: () => '/media/x' } as unknown as MediaService;
    const audit = { log: async () => undefined } as unknown as AuditService;
    clips = new ClipsService(prisma, pipeline, media, audit);
  });

  afterAll(async () => {
    if (userId) await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  /** Proyecto con original, transcripción y dos clips, como tras un análisis real. */
  async function analysedProject() {
    const project = await prisma.project.create({
      data: { userId, name: 'Editor', maxClips: 3, minDuration: 15, maxDuration: 60, source: { create: { kind: 'UPLOAD', provider: 'UPLOAD', uploadKey: 'u' } } },
    });
    await pipeline.startImport(project, { type: 'upload', storageKey: `uploads/${userId}/${project.id}/a.mp4` });
    const imp = queues.enqueued.find((e) => e.data.kind === 'import')!.data;
    await pipeline.onStart(imp.jobId);
    const asset: ImportResult = {
      asset: { key: `originals/${userId}/${project.id}/o.mp4`, sizeBytes: 1000, durationSec: 600, width: 1920, height: 1080, fps: 30,
        hasAudio: true, hasVideo: true, videoCodec: 'h264', audioCodec: 'aac', container: 'mp4' },
      title: null,
    };
    await pipeline.onComplete(imp.jobId, asset);
    const ana = queues.enqueued.find((e) => e.data.kind === 'analyze')!.data;
    await pipeline.onStart(ana.jobId);
    const result: AnalyzeResult = {
      language: 'es', languageProbability: 0.9, durationSec: 600, transcriptKey: null, srtKey: null, model: 'small', device: 'cpu',
      timings: {}, modules: { transcription: 'ok', audio: 'ok', visual: 'ok', semantic: 'ok', llm: 'skipped' },
      segments: [
        { start: 10, end: 12, text: 'klk mi gente', words: [{ start: 10, end: 10.4, word: 'klk', probability: 0.3 }, { start: 10.4, end: 10.8, word: 'mi', probability: 0.9 }, { start: 10.8, end: 11.5, word: 'gente', probability: 0.9 }] },
        { start: 100, end: 101, text: 'eso', words: [{ start: 100, end: 101, word: 'eso', probability: 0.9 }] },
      ],
      candidates: [
        { start: 5, end: 40, peakTime: 12, score: 82, title: 'Saludo', reason: 'Pico', text: '', signals: { audio: 0.9, semantic: 0.6 }, tags: ['pico_audio'] },
        { start: 95, end: 130, peakTime: 101, score: 70, title: 'Final', reason: 'Risas', text: '', signals: { emotion: 0.8 }, tags: [] },
      ],
    };
    await pipeline.onComplete(ana.jobId, result);
    const rows = await prisma.clip.findMany({ where: { projectId: project.id }, orderBy: { start: 'asc' } });
    queues.enqueued = [];
    return { project, rows };
  }

  it('los clips nuevos llevan título gancho y el desglose de la puntuación', async () => {
    const { rows } = await analysedProject();
    expect(rows[0].hookEnabled).toBe(true);
    const detail = await clips.detail(userId, rows[0].id);
    expect(detail.candidate?.signals).toEqual({ audio: 0.9, semantic: 0.6 });
    await pipeline.enqueueRender(rows[0].id);
    expect(queues.renders()[0].hook).toEqual({ text: 'Saludo', durationSec: 3 });
  });

  it('corregir palabras cambia el texto del subtítulo, no los tiempos', async () => {
    const { rows } = await analysedProject();
    const { original } = await clips.words(userId, rows[0].id);
    expect(original.map((w) => w.word)).toEqual(['klk', 'mi', 'gente']);
    const edited = original.map((w) => ({ start: w.start, end: w.end, word: w.word === 'klk' ? 'KLK' : w.word === 'mi' ? '' : w.word }));
    const saved = await clips.setWords(userId, rows[0].id, edited);
    expect(saved.words.map((w) => w.word)).toEqual(['KLK', 'gente']);
    await expect(clips.setWords(userId, rows[0].id, [{ start: 10.1, end: 10.4, word: 'x' }])).rejects.toThrow('tiempos');

    await pipeline.enqueueRender(rows[0].id);
    expect(queues.renders()[0].subtitles.words.map((w) => [w.start, w.word])).toEqual([[10, 'KLK'], [10.8, 'gente']]);

    const reset = await clips.resetWords(userId, rows[0].id);
    expect(reset.edited).toBe(false);
    expect(reset.words.map((w) => w.word)).toEqual(['klk', 'mi', 'gente']);
  });

  it('una fuente propia se resuelve a su familia y viaja con el render; la de otro usuario se rechaza', async () => {
    const { rows } = await analysedProject();
    const font = await prisma.userFont.create({ data: { userId, family: 'Mi Letra', fileName: 'a.ttf', storageKey: `fonts/${userId}/f-${Date.now()}.ttf`, sizeBytes: 10 } });
    await clips.update(userId, rows[0].id, { subtitleStyle: { font: `custom:${font.id}`, preset: 'neon' } });
    await pipeline.enqueueRender(rows[0].id);
    const job = queues.renders()[0];
    expect(job.subtitles.style).toMatchObject({ font: 'Mi Letra', preset: 'neon' });
    expect(job.fonts).toEqual([{ key: font.storageKey, family: 'Mi Letra' }]);
    await expect(clips.update(userId, rows[0].id, { subtitleStyle: { font: 'custom:00000000-0000-0000-0000-000000000000' } })).rejects.toThrow('Fuente');
  });

  it('aplicar un estilo al proyecto actualiza y vuelve a renderizar todos los clips', async () => {
    const { project, rows } = await analysedProject();
    // Los renders iniciales siguen pendientes: se marcan listos para que el estilo pueda encolarse.
    await prisma.clipRender.updateMany({ where: { clipId: { in: rows.map((r) => r.id) } }, data: { status: 'READY' } });
    const r = await clips.applyStyleToProject(userId, project.id, { preset: 'podcast', fontSize: 64 }, true);
    expect(r).toEqual({ updated: 2, queued: 2 });
    expect(queues.renders().every((j) => j.subtitles.style.preset === 'podcast' && j.subtitles.style.fontSize === 64)).toBe(true);
  });

  it('combinar clips crea uno nuevo con los tramos en orden y no toca los originales', async () => {
    const { rows } = await analysedProject();
    const merged = await clips.merge(userId, [rows[1].id, rows[0].id]);
    expect(merged.segments).toEqual([{ start: 95, end: 130 }, { start: 5, end: 40 }]);
    expect(merged.title).toBe('Final + Saludo');
    const job = queues.renders().find((j) => j.clipId === merged.id)!;
    expect(job.segments).toEqual([{ start: 95, end: 130 }, { start: 5, end: 40 }]);
    expect(job.subtitles.words.map((w) => w.word)).toEqual(['klk', 'mi', 'gente', 'eso']);
    await expect(clips.update(userId, merged.id, { start: 0 })).rejects.toThrow('combinado');
    expect(await prisma.clip.count({ where: { projectId: rows[0].projectId, deletedAt: null } })).toBe(3);
  });
});
