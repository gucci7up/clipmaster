import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { AgentsAdminController, AgentsController } from './agents/agents.controller';
import { AgentsService } from './agents/agents.service';
import { AuthController } from './auth/auth.controller';
import { AuthGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { ClipsController } from './clips/clips.controller';
import { ClipsService } from './clips/clips.service';
import { AuditService } from './common/audit.service';
import { PrismaService } from './common/prisma.service';
import { RedisService } from './common/redis.service';
import { StorageService } from './common/storage.service';
import { env } from './config/env';
import { EventsController } from './events/events.controller';
import { EventsService } from './events/events.service';
import { HealthController } from './health/health.controller';
import { MaintenanceService } from './maintenance/maintenance.service';
import { MediaController } from './media/media.controller';
import { MediaService } from './media/media.service';
import { InternalController } from './pipeline/internal.controller';
import { PipelineService } from './pipeline/pipeline.service';
import { QueueService } from './pipeline/queue.service';
import { ReconcilerService } from './pipeline/reconciler.service';
import { ProjectsController } from './projects/projects.controller';
import { ProjectsService } from './projects/projects.service';
import { SettingsController } from './settings/settings.controller';
import { SourcesService } from './sources/sources.service';
import { StatsController } from './stats/stats.controller';

@Global()
@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: env().LOG_LEVEL,
        // Logs JSON en una línea: legibles desde la pestaña de logs de Dokploy y agregables.
        redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        autoLogging: { ignore: (req) => Boolean(req.url?.startsWith('/api/health') || req.url?.startsWith('/api/media')) },
        customProps: () => ({ service: 'clipmaster-api' }),
      },
    }),
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: env().RATE_LIMIT_PER_MINUTE }]),
  ],
  controllers: [
    AuthController,
    ProjectsController,
    ClipsController,
    MediaController,
    EventsController,
    StatsController,
    HealthController,
    SettingsController,
    InternalController,
    AgentsController,
    AgentsAdminController,
  ],
  providers: [
    PrismaService,
    RedisService,
    StorageService,
    AuditService,
    AuthService,
    AgentsService,
    EventsService,
    QueueService,
    PipelineService,
    ReconcilerService,
    MaintenanceService,
    MediaService,
    SourcesService,
    ProjectsService,
    ClipsService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [PrismaService, RedisService, StorageService],
})
export class AppModule {}
