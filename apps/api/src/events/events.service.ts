import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EVENTS_CHANNEL } from '@clipmaster/shared';
import { Observable, Subject, filter, map } from 'rxjs';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { env } from '../config/env';

export interface AppEvent {
  userId: string;
  projectId: string;
  type: string;
  jobId?: string | null;
  stage?: string | null;
  progress?: number | null;
  message?: string | null;
  data?: Record<string, unknown>;
  at?: string;
}

/**
 * Eventos en tiempo real: se persisten (historial) y se difunden por Redis pub/sub,
 * de modo que cualquier réplica de la API pueda reenviarlos por SSE a su usuario.
 */
@Injectable()
export class EventsService implements OnModuleInit {
  private readonly log = new Logger(EventsService.name);
  private readonly stream = new Subject<AppEvent>();

  constructor(private readonly prisma: PrismaService, private readonly redis: RedisService) {}

  async onModuleInit() {
    if (env().NODE_ENV === 'test') return;
    const sub = this.redis.getSubscriber();
    await sub.subscribe(EVENTS_CHANNEL);
    sub.on('message', (_channel, raw) => {
      try {
        this.stream.next(JSON.parse(raw) as AppEvent);
      } catch {
        this.log.warn('Evento inválido recibido por pub/sub');
      }
    });
  }

  async emit(event: AppEvent, persist = true) {
    const payload = { ...event, at: new Date().toISOString() };
    if (persist) {
      await this.prisma.processingEvent
        .create({
          data: {
            projectId: event.projectId,
            jobId: event.jobId ?? null,
            type: event.type,
            stage: event.stage ?? null,
            progress: event.progress ?? null,
            message: event.message ?? null,
            data: (event.data ?? undefined) as Prisma.InputJsonValue | undefined,
          },
        })
        .catch((err) => this.log.warn(`No se pudo persistir evento: ${err.message}`));
    }
    if (env().NODE_ENV === 'test') {
      this.stream.next(payload);
      return;
    }
    await this.redis.client.publish(EVENTS_CHANNEL, JSON.stringify(payload));
  }

  forUser(userId: string): Observable<{ data: AppEvent }> {
    return this.stream.pipe(
      filter((e) => e.userId === userId),
      map((e) => {
        const { userId: _omit, ...rest } = e;
        return { data: rest as AppEvent };
      }),
    );
  }
}
