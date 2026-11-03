import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CaptureAgent, JobStatus, Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import type { ImportJobData } from '@clipmaster/shared';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { env } from '../config/env';

/** Cola lógica (sólo PostgreSQL, sin BullMQ) de las importaciones que hace un capturador remoto. */
export const AGENT_QUEUE = 'capture-agent';
/** Etapa visible mientras ningún capturador ha tomado el trabajo. */
export const WAITING_STAGE = 'waiting_agent';
/** Si el capturador deja de dar señales durante este tiempo, el trabajo vuelve a la cola. */
export const LEASE_SEC = 120;
const ONLINE_SEC = 60;
const TOKEN_PREFIX = 'cma_';

const leaseKey = (jobId: string) => `clipmaster:agent:lease:${jobId}`;
const onlineKey = (agentId: string) => `clipmaster:agent:online:${agentId}`;

export function hashAgentToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function usesAgent(provider: string): boolean {
  return env().AGENT_PROVIDERS.includes(provider.toUpperCase());
}

/** Clave de salida que el capturador puede subir para un job: la misma que calcula el worker. */
export function expectedUploadKey(job: Pick<ImportJobData, 'jobId' | 'outputPrefix'>): string {
  return `${job.outputPrefix.replace(/\/+$/, '')}/${job.jobId}.mp4`;
}

@Injectable()
export class AgentsService {
  private readonly log = new Logger(AgentsService.name);

  constructor(private readonly prisma: PrismaService, private readonly redis: RedisService) {}

  // ---------------------------------------------------------------- administración

  async create(createdById: string, name: string) {
    const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
    const agent = await this.prisma.captureAgent.create({
      data: { name: name.trim().slice(0, 80), tokenHash: hashAgentToken(token), tokenPrefix: token.slice(0, 10), createdById },
    });
    // El token sólo se devuelve aquí: en la base de datos queda su hash.
    return { agent: await this.describe(agent), token };
  }

  async list() {
    const agents = await this.prisma.captureAgent.findMany({ where: { revokedAt: null }, orderBy: { createdAt: 'desc' } });
    return Promise.all(agents.map((a) => this.describe(a)));
  }

  async revoke(id: string) {
    const agent = await this.prisma.captureAgent.findUnique({ where: { id } });
    if (!agent || agent.revokedAt) throw new NotFoundException('Capturador no encontrado');
    await this.prisma.captureAgent.update({ where: { id }, data: { revokedAt: new Date() } });
    await this.redis.client.del(onlineKey(id));
  }

  async anyOnline(): Promise<boolean> {
    const agents = await this.prisma.captureAgent.findMany({ where: { revokedAt: null }, select: { id: true } });
    if (!agents.length) return false;
    const flags = await this.redis.client.mget(agents.map((a) => onlineKey(a.id)));
    return flags.some(Boolean);
  }

  private async describe(a: CaptureAgent) {
    const online = Boolean(await this.redis.client.exists(onlineKey(a.id)));
    return { id: a.id, name: a.name, tokenPrefix: a.tokenPrefix, createdAt: a.createdAt, lastSeenAt: a.lastSeenAt, online };
  }

  // ---------------------------------------------------------------- autenticación

  async authenticate(token: string): Promise<CaptureAgent | null> {
    if (!token.startsWith(TOKEN_PREFIX)) return null;
    const agent = await this.prisma.captureAgent.findUnique({ where: { tokenHash: hashAgentToken(token) } });
    if (!agent || agent.revokedAt) return null;
    return agent;
  }

  /** Marca el capturador como conectado (cada petición cuenta como latido). */
  async touch(agent: CaptureAgent) {
    await this.redis.client.set(onlineKey(agent.id), '1', 'EX', ONLINE_SEC);
    if (!agent.lastSeenAt || Date.now() - agent.lastSeenAt.getTime() > 30_000) {
      await this.prisma.captureAgent.update({ where: { id: agent.id }, data: { lastSeenAt: new Date() } });
    }
  }

  // ---------------------------------------------------------------- trabajos

  /**
   * Asigna al capturador el trabajo en espera más antiguo. `FOR UPDATE SKIP LOCKED` garantiza que
   * dos capturadores nunca tomen el mismo, y el lease en Redis permite recuperarlo si se desconecta.
   */
  async claim(agent: CaptureAgent): Promise<ImportJobData | null> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      UPDATE "ProcessingJob" SET "stage" = 'claimed', "updatedAt" = NOW()
      WHERE "id" = (
        SELECT j."id" FROM "ProcessingJob" j
        JOIN "Project" p ON p."id" = j."projectId"
        WHERE j."queue" = ${AGENT_QUEUE} AND j."status" = 'QUEUED'::"JobStatus"
          AND (j."stage" IS NULL OR j."stage" = ${WAITING_STAGE}) AND p."deletedAt" IS NULL
        ORDER BY j."queuedAt" ASC
        LIMIT 1
        FOR UPDATE OF j SKIP LOCKED
      )
      RETURNING "id"`);
    if (!rows.length) return null;
    const job = await this.prisma.processingJob.findUniqueOrThrow({ where: { id: rows[0].id } });
    await this.redis.client.set(leaseKey(job.id), agent.id, 'EX', LEASE_SEC);
    this.log.log(`Job ${job.id} asignado al capturador ${agent.name}`);
    return job.payload as unknown as ImportJobData;
  }

  /** Comprueba que el job pertenece a este capturador y renueva su lease. */
  async assertOwner(agent: CaptureAgent, jobId: string) {
    const owner = await this.redis.client.get(leaseKey(jobId));
    if (owner !== agent.id) throw new ForbiddenException('Este trabajo no está asignado a este capturador');
    await this.redis.client.expire(leaseKey(jobId), LEASE_SEC);
    const job = await this.prisma.processingJob.findUnique({ where: { id: jobId }, include: { project: true } });
    if (!job || job.queue !== AGENT_QUEUE) throw new NotFoundException('Trabajo desconocido');
    return job;
  }

  async release(jobId: string) {
    await this.redis.client.del(leaseKey(jobId));
  }

  async hasLease(jobId: string): Promise<boolean> {
    return Boolean(await this.redis.client.exists(leaseKey(jobId)));
  }

  /** Devuelve a la cola un trabajo cuyo capturador se desconectó a mitad. */
  async requeue(jobId: string) {
    await this.prisma.processingJob.updateMany({
      where: { id: jobId, status: { in: [JobStatus.QUEUED, JobStatus.RUNNING] } },
      data: { status: JobStatus.QUEUED, stage: WAITING_STAGE, progress: null },
    });
  }
}
