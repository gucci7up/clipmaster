/**
 * Integración del capturador remoto con PostgreSQL real: los enlaces de YouTube van a la cola del
 * capturador, sólo un capturador puede tomarlos, el lease protege cada llamada y un capturador
 * desconectado devuelve el trabajo a la cola. Redis se sustituye por un mapa en memoria.
 *
 *   TEST_DATABASE_URL=postgresql://... pnpm --filter @clipmaster/api test
 */
import type { AnyJobData, ImportJobData } from '@clipmaster/shared';
import { JobStatus, ProjectStatus } from '@prisma/client';
import { AGENT_QUEUE, AgentsService, expectedUploadKey, WAITING_STAGE } from '../src/agents/agents.service';
import type { PrismaService } from '../src/common/prisma.service';
import type { RedisService } from '../src/common/redis.service';
import { loadEnv, setEnvForTests } from '../src/config/env';
import { EventsService } from '../src/events/events.service';
import { PipelineService } from '../src/pipeline/pipeline.service';
import type { QueueService } from '../src/pipeline/queue.service';

const DB = process.env.TEST_DATABASE_URL;
const run = DB ? describe : describe.skip;

class MemoryRedis {
  store = new Map<string, string>();
  async set(k: string, v: string) { this.store.set(k, v); return 'OK'; }
  async get(k: string) { return this.store.get(k) ?? null; }
  async del(k: string) { return this.store.delete(k) ? 1 : 0; }
  async exists(k: string) { return this.store.has(k) ? 1 : 0; }
  async expire() { return 1; }
  async mget(keys: string[]) { return keys.map((k) => this.store.get(k) ?? null); }
}

class FakeQueues {
  enqueued: { queue: string; data: AnyJobData }[] = [];
  async enqueue(queue: string, data: AnyJobData) { this.enqueued.push({ queue, data }); }
  async signalCancel() {}
  async removeIfPending() { return true; }
  async signalStopCapture() {}
}

run('capturador remoto (PostgreSQL real)', () => {
  let prisma: PrismaService;
  let redis: MemoryRedis;
  let queues: FakeQueues;
  let pipeline: PipelineService;
  let agents: AgentsService;
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
    const user = await prisma.user.create({ data: { email: `agent-${Date.now()}@example.com`, name: 'Agent', passwordHash: 'x', role: 'ADMIN' } });
    userId = user.id;
  });

  beforeEach(async () => {
    // Cada prueba parte sin trabajos de capturador pendientes de otras pruebas.
    await prisma.processingJob.deleteMany({ where: { queue: AGENT_QUEUE } });
    redis = new MemoryRedis();
    queues = new FakeQueues();
    const redisService = { client: redis } as unknown as RedisService;
    agents = new AgentsService(prisma, redisService);
    pipeline = new PipelineService(prisma, queues as unknown as QueueService, new EventsService(prisma, {} as never));
  });

  afterAll(async () => {
    if (userId) await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  async function youtubeProject() {
    const project = await prisma.project.create({
      data: { userId, name: 'YT', source: { create: { kind: 'URL', provider: 'YOUTUBE', url: 'https://www.youtube.com/watch?v=abc' } } },
    });
    await pipeline.startImport(project, { type: 'url', url: 'https://www.youtube.com/watch?v=abc', provider: 'YOUTUBE' });
    return project;
  }

  it('los enlaces de YouTube van a la cola del capturador y no a BullMQ', async () => {
    const project = await youtubeProject();
    const job = await prisma.processingJob.findFirstOrThrow({ where: { projectId: project.id } });
    expect(job.queue).toBe(AGENT_QUEUE);
    expect(job.stage).toBe(WAITING_STAGE);
    expect(queues.enqueued).toHaveLength(0);
  });

  it('otros proveedores siguen yendo al capture-worker del servidor', async () => {
    const project = await prisma.project.create({ data: { userId, name: 'TW', source: { create: { kind: 'URL', provider: 'TWITCH', url: 'https://twitch.tv/videos/1' } } } });
    await pipeline.startImport(project, { type: 'url', url: 'https://twitch.tv/videos/1', provider: 'TWITCH' });
    expect(queues.enqueued.map((e) => e.queue)).toEqual(['capture']);
  });

  it('el token se guarda como hash, autentica y deja de valer al revocarlo', async () => {
    const { agent, token } = await agents.create(userId, 'PC de casa');
    const stored = await prisma.captureAgent.findUniqueOrThrow({ where: { id: agent.id } });
    expect(stored.tokenHash).not.toContain(token);
    expect((await agents.authenticate(token))?.id).toBe(agent.id);
    expect(await agents.authenticate(token + 'x')).toBeNull();
    await agents.revoke(agent.id);
    expect(await agents.authenticate(token)).toBeNull();
  });

  it('sólo un capturador toma cada trabajo, y sólo él puede operar con él', async () => {
    const project = await youtubeProject();
    const a = (await agents.create(userId, 'A')).agent;
    const b = (await agents.create(userId, 'B')).agent;
    const rowA = await prisma.captureAgent.findUniqueOrThrow({ where: { id: a.id } });
    const rowB = await prisma.captureAgent.findUniqueOrThrow({ where: { id: b.id } });

    const [ja, jb] = await Promise.all([agents.claim(rowA), agents.claim(rowB)]);
    const claimed = [ja, jb].filter(Boolean) as ImportJobData[];
    expect(claimed).toHaveLength(1);
    expect(claimed[0].projectId).toBe(project.id);

    const owner = ja ? rowA : rowB;
    const other = ja ? rowB : rowA;
    await expect(agents.assertOwner(other, claimed[0].jobId)).rejects.toThrow('no está asignado');
    const job = await agents.assertOwner(owner, claimed[0].jobId);
    expect(expectedUploadKey(job.payload as unknown as ImportJobData)).toBe(`originals/${userId}/${project.id}/${claimed[0].jobId}.mp4`);
    expect(await agents.claim(owner)).toBeNull();
  });

  it('si el capturador se desconecta, el trabajo vuelve a la cola y otro lo puede tomar', async () => {
    await youtubeProject();
    const row = await prisma.captureAgent.findUniqueOrThrow({ where: { id: (await agents.create(userId, 'A')).agent.id } });
    const job = (await agents.claim(row))!;
    await pipeline.onStart(job.jobId);
    expect((await prisma.processingJob.findUniqueOrThrow({ where: { id: job.jobId } })).status).toBe(JobStatus.RUNNING);

    await agents.release(job.jobId); // equivale a que caduque el lease
    expect(await agents.hasLease(job.jobId)).toBe(false);
    await agents.requeue(job.jobId);
    const again = (await agents.claim(row))!;
    expect(again.jobId).toBe(job.jobId);
  });

  it('un trabajo completado por el capturador continúa el pipeline normal (análisis)', async () => {
    const project = await youtubeProject();
    const row = await prisma.captureAgent.findUniqueOrThrow({ where: { id: (await agents.create(userId, 'A')).agent.id } });
    const job = (await agents.claim(row))!;
    await pipeline.onStart(job.jobId);
    await pipeline.onComplete(job.jobId, {
      asset: {
        key: expectedUploadKey(job), sizeBytes: 1000, durationSec: 120, width: 1280, height: 720, fps: 30,
        hasAudio: true, hasVideo: true, videoCodec: 'h264', audioCodec: 'aac', container: 'mp4',
      },
      title: 'Mi video',
    });
    expect(queues.enqueued.map((e) => e.data.kind)).toEqual(['analyze']);
    const p = await prisma.project.findUniqueOrThrow({ where: { id: project.id }, include: { source: true } });
    expect(p.status).toBe(ProjectStatus.TRANSCRIBING);
    expect(p.source?.title).toBe('Mi video');
  });

  it('cancelar un proyecto en espera no toca BullMQ y el capturador ya no lo toma', async () => {
    const project = await youtubeProject();
    await pipeline.cancelProject(await prisma.project.findUniqueOrThrow({ where: { id: project.id } }));
    const row = await prisma.captureAgent.findUniqueOrThrow({ where: { id: (await agents.create(userId, 'A')).agent.id } });
    expect(await agents.claim(row)).toBeNull();
  });
});
