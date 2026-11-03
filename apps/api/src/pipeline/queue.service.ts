import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { CANCEL_KEY, QUEUE_PREFIX, Queues, QueueName, STOP_CAPTURE_KEY, AnyJobData } from '@clipmaster/shared';
import { Job, JobsOptions, Queue } from 'bullmq';
import { RedisService } from '../common/redis.service';
import { env } from '../config/env';

/**
 * Productor BullMQ. Los consumidores son los workers Python (librería `bullmq` de Python),
 * compatibles con la estructura de Redis de BullMQ. Ver docs/ARCHITECTURE.md §3.
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly log = new Logger(QueueService.name);
  private readonly queues = new Map<QueueName, Queue>();

  constructor(private readonly redis: RedisService) {}

  queue(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.redis.createBullConnection(), prefix: QUEUE_PREFIX });
      this.queues.set(name, q);
    }
    return q;
  }

  jobOptions(jobId: string, kind: AnyJobData['kind']): JobsOptions {
    const attempts = kind === 'live' ? 5 : env().JOB_ATTEMPTS;
    return {
      jobId,
      attempts,
      backoff: { type: 'exponential', delay: kind === 'live' ? 15_000 : 10_000 },
      removeOnComplete: { age: 7 * 86400, count: 5000 },
      removeOnFail: { age: 30 * 86400 },
      priority: kind === 'render' ? 2 : kind === 'analyze' ? 3 : 1,
    };
  }

  async enqueue(queue: QueueName, data: AnyJobData): Promise<void> {
    await this.queue(queue).add(data.kind, data, this.jobOptions(data.jobId, data.kind));
  }

  async getJob(queue: QueueName, jobId: string): Promise<Job | undefined> {
    return this.queue(queue).getJob(jobId);
  }

  /** Elimina un job pendiente (waiting/delayed). Los activos se detienen vía clave de cancelación. */
  async removeIfPending(queue: QueueName, jobId: string): Promise<boolean> {
    const job = await this.getJob(queue, jobId);
    if (!job) return false;
    const state = await job.getState();
    if (state === 'waiting' || state === 'delayed' || state === 'prioritized') {
      await job.remove().catch(() => undefined);
      return true;
    }
    return false;
  }

  async signalCancel(projectId: string) {
    await this.redis.client.set(CANCEL_KEY(projectId), '1', 'EX', 86400);
  }

  async clearCancel(projectId: string) {
    await this.redis.client.del(CANCEL_KEY(projectId));
  }

  async signalStopCapture(captureSessionId: string) {
    await this.redis.client.set(STOP_CAPTURE_KEY(captureSessionId), '1', 'EX', 86400);
  }

  async counts() {
    const out: Record<string, Record<string, number>> = {};
    for (const name of Object.values(Queues)) {
      out[name] = await this.queue(name).getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed', 'prioritized');
    }
    return out;
  }

  async onModuleDestroy() {
    await Promise.allSettled([...this.queues.values()].map((q) => q.close()));
  }
}
