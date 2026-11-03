import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import { Public, Roles } from '../auth/auth.guard';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { StorageService } from '../common/storage.service';
import { QueueService } from '../pipeline/queue.service';

async function timed<T>(fn: () => Promise<T>): Promise<{ ok: boolean; ms: number; error?: string }> {
  const t = Date.now();
  try {
    await fn();
    return { ok: true, ms: Date.now() - t };
  } catch (err) {
    return { ok: false, ms: Date.now() - t, error: (err as Error).message };
  }
}

@ApiTags('health')
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly storage: StorageService,
    private readonly queues: QueueService,
  ) {}

  /** Liveness para el healthcheck del contenedor. */
  @Public()
  @Get('live')
  live() {
    return { ok: true };
  }

  /** Readiness: dependencias críticas. */
  @Public()
  @Get()
  async ready() {
    const [db, redis, storage] = await Promise.all([
      timed(() => this.prisma.$queryRaw`SELECT 1`),
      timed(() => this.redis.client.ping()),
      timed(() => this.storage.ping()),
    ]);
    const workers = await this.workers().catch(() => []);
    const ok = db.ok && redis.ok && storage.ok;
    const body = { ok, db, redis, storage, workers: workers.map((w) => ({ role: w.role, device: w.device, busy: w.busy })) };
    if (!ok) throw new ServiceUnavailableException(body);
    return body;
  }

  /** Estado detallado del sistema (sólo administradores). */
  @Roles(Role.ADMIN)
  @Get('system')
  async system() {
    return { queues: await this.queues.counts(), workers: await this.workers() };
  }

  private async workers() {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.client.scan(cursor, 'MATCH', 'clipmaster:worker:*', 'COUNT', 100);
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    if (!keys.length) return [];
    const values = await this.redis.client.mget(keys);
    return values.filter(Boolean).map((v) => JSON.parse(v!) as { role: string; device: string; busy: number; [k: string]: unknown });
  }
}
