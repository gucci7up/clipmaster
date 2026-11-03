import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { QUEUE_PREFIX } from '@clipmaster/shared';
import { Queue, Worker } from 'bullmq';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { StorageService } from '../common/storage.service';
import { env } from '../config/env';

const QUEUE = 'maintenance';

/**
 * Limpieza periódica orquestada con BullMQ (job scheduler, ejecución única entre réplicas):
 * borra objetos temporales/caducados y de proyectos eliminados, sesiones expiradas y
 * recalcula el uso de cuota.
 */
@Injectable()
export class MaintenanceService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(MaintenanceService.name);
  private queue?: Queue;
  private worker?: Worker;

  constructor(private readonly prisma: PrismaService, private readonly storage: StorageService, private readonly redis: RedisService) {}

  async onApplicationBootstrap() {
    if (env().NODE_ENV === 'test') return;
    this.queue = new Queue(QUEUE, { connection: this.redis.createBullConnection(), prefix: QUEUE_PREFIX });
    await this.queue.upsertJobScheduler('cleanup', { every: 15 * 60_000 }, { name: 'cleanup', opts: { removeOnComplete: 50, removeOnFail: 50 } });
    this.worker = new Worker(QUEUE, async () => this.cleanup(), {
      connection: this.redis.createBullConnection(),
      prefix: QUEUE_PREFIX,
      concurrency: 1,
    });
    this.worker.on('failed', (_job, err) => this.log.error(`Limpieza fallida: ${err.message}`));
  }

  async onModuleDestroy() {
    await Promise.allSettled([this.worker?.close(), this.queue?.close()]);
  }

  async cleanup() {
    const now = new Date();
    // 1) Borrado (uploads ya normalizados, clips/proyectos eliminados, temporales) de objetos caducados.
    const expired = await this.prisma.storageAsset.findMany({
      where: { temporary: true, deletedAt: null, expiresAt: { lte: now } },
      take: 500,
    });
    let freed = 0n;
    for (const a of expired) {
      try {
        await this.storage.delete(a.key);
        await this.prisma.$transaction([
          this.prisma.storageAsset.update({ where: { id: a.id }, data: { deletedAt: now } }),
          this.prisma.user.update({ where: { id: a.userId }, data: { storageUsedBytes: { decrement: a.sizeBytes } } }),
        ]);
        freed += a.sizeBytes;
      } catch (err) {
        this.log.warn(`No se pudo borrar ${a.key}: ${(err as Error).message}`);
      }
    }

    // 2) Proyectos eliminados: purga definitiva de filas tras borrar sus objetos.
    const purge = await this.prisma.project.findMany({
      where: { deletedAt: { lt: new Date(Date.now() - 24 * 3600_000) } },
      select: { id: true },
      take: 50,
    });
    for (const p of purge) {
      const pending = await this.prisma.storageAsset.count({ where: { projectId: p.id, deletedAt: null } });
      if (pending === 0) await this.prisma.project.delete({ where: { id: p.id } }).catch(() => undefined);
    }

    // 3) Sesiones expiradas.
    const sessions = await this.prisma.session.deleteMany({ where: { expiresAt: { lt: now } } });

    // 4) Corrección de deriva en el contador de cuota.
    await this.prisma.$executeRaw`UPDATE "User" u SET "storageUsedBytes" = COALESCE((SELECT SUM(a."sizeBytes") FROM "StorageAsset" a WHERE a."userId" = u.id AND a."deletedAt" IS NULL), 0)`;

    if (expired.length || sessions.count) {
      this.log.log(`Limpieza: ${expired.length} objetos (${Number(freed / 1024n / 1024n)} MiB), ${sessions.count} sesiones`);
    }
    return { objects: expired.length, freedBytes: Number(freed), sessions: sessions.count };
  }
}
