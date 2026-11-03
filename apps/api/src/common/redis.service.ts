import { Injectable, OnModuleDestroy } from '@nestjs/common';
import IORedis, { Redis } from 'ioredis';
import { env } from '../config/env';

/** Conexiones Redis compartidas: comandos, suscriptor pub/sub y la usada por BullMQ. */
@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;
  private subscriber: Redis | null = null;

  constructor() {
    this.client = new IORedis(env().REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: false });
  }

  /** Conexión dedicada para BullMQ (requiere maxRetriesPerRequest: null). */
  createBullConnection(): Redis {
    return new IORedis(env().REDIS_URL, { maxRetriesPerRequest: null });
  }

  getSubscriber(): Redis {
    if (!this.subscriber) this.subscriber = new IORedis(env().REDIS_URL, { maxRetriesPerRequest: null });
    return this.subscriber;
  }

  async onModuleDestroy() {
    await Promise.allSettled([this.client.quit(), this.subscriber?.quit()]);
  }
}
