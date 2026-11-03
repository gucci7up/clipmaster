import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { JobStatus } from '@prisma/client';
import type { AnyJobData, QueueName } from '@clipmaster/shared';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { env } from '../config/env';
import { PipelineService, TERMINAL_PROJECT } from './pipeline.service';
import { QueueService } from './queue.service';

const STALE_MS = 2 * 60_000;
const LOCK_KEY = 'clipmaster:reconciler:lock';

/**
 * Reconcilia PostgreSQL con BullMQ para que ningún proyecto quede bloqueado:
 *  - job perdido en Redis → se reencola (mismo jobId);
 *  - job fallido definitivamente sin notificación → se marca fallido;
 *  - job completado cuyo resultado no llegó → se aplica su returnvalue;
 *  - proyecto no terminal sin jobs activos → se evalúa su cierre.
 */
@Injectable()
export class ReconcilerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(ReconcilerService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueService,
    private readonly pipeline: PipelineService,
    private readonly redis: RedisService,
  ) {}

  onApplicationBootstrap() {
    if (env().NODE_ENV === 'test') return;
    setTimeout(() => void this.tick(), 10_000);
    this.timer = setInterval(() => void this.tick(), 60_000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    // Un único reconciliador activo entre réplicas.
    const got = await this.redis.client.set(LOCK_KEY, '1', 'EX', 55, 'NX').catch(() => null);
    if (!got) return;
    try {
      await this.reconcile();
    } catch (err) {
      this.log.error(`Reconciliación fallida: ${(err as Error).message}`);
    }
  }

  async reconcile() {
    const stale = await this.prisma.processingJob.findMany({
      where: { status: { in: [JobStatus.QUEUED, JobStatus.RUNNING] }, updatedAt: { lt: new Date(Date.now() - STALE_MS) } },
      take: 200,
    });
    for (const row of stale) {
      const job = await this.queues.getJob(row.queue as QueueName, row.id);
      if (!job) {
        if (row.attempts >= env().JOB_ATTEMPTS + 2) {
          await this.pipeline.onFail(row.id, 'El trabajo se perdió repetidamente en la cola', false, row.attempts);
        } else {
          this.log.warn(`Job ${row.id} no existe en BullMQ; reencolando`);
          await this.queues.enqueue(row.queue as QueueName, row.payload as unknown as AnyJobData);
          await this.prisma.processingJob.update({ where: { id: row.id }, data: { status: JobStatus.QUEUED, attempts: { increment: 1 } } });
        }
        continue;
      }
      const state = await job.getState();
      if (state === 'failed') {
        await this.pipeline.onFail(row.id, job.failedReason || 'Fallo en el worker', false, job.attemptsMade);
      } else if (state === 'completed' && job.returnvalue) {
        await this.pipeline.onComplete(row.id, job.returnvalue);
      } else {
        // Sigue en curso o en espera: sólo refresca updatedAt para no revisarlo en cada ciclo.
        await this.prisma.processingJob.update({ where: { id: row.id }, data: { stage: row.stage } });
      }
    }

    const open = await this.prisma.project.findMany({
      where: { status: { notIn: TERMINAL_PROJECT }, startedAt: { lt: new Date(Date.now() - STALE_MS) }, deletedAt: null },
      select: { id: true },
      take: 200,
    });
    for (const p of open) await this.pipeline.checkCompletion(p.id);
  }
}
