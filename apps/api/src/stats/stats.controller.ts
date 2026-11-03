import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ClipStatus, ProjectStatus } from '@prisma/client';
import { AuthUser, CurrentUser } from '../auth/auth.guard';
import { PrismaService } from '../common/prisma.service';
import { toJSONSafe } from '../common/json';
import { TERMINAL_PROJECT } from '../pipeline/pipeline.service';

@ApiTags('stats')
@Controller('stats')
export class StatsController {
  constructor(private readonly prisma: PrismaService) {}

  /** Métricas del dashboard calculadas sobre datos reales. */
  @Get('overview')
  async overview(@CurrentUser() user: AuthUser) {
    const base = { userId: user.id, deletedAt: null };
    const [projects, processed, active, clips, user_, duration, processing, recent] = await Promise.all([
      this.prisma.project.count({ where: base }),
      this.prisma.project.count({ where: { ...base, status: ProjectStatus.COMPLETED } }),
      this.prisma.project.count({ where: { ...base, status: { notIn: TERMINAL_PROJECT } } }),
      this.prisma.clip.count({ where: { deletedAt: null, status: ClipStatus.READY, project: base } }),
      this.prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { storageUsedBytes: true, storageQuotaBytes: true } }),
      this.prisma.videoAsset.aggregate({ _sum: { durationSec: true }, where: { project: base } }),
      this.prisma.project.aggregate({ _sum: { processingMs: true }, where: base }),
      this.prisma.project.findMany({
        where: base,
        orderBy: { createdAt: 'desc' },
        take: 5,
        include: { source: { select: { provider: true, isLive: true, title: true } }, _count: { select: { clips: { where: { deletedAt: null } } } } },
      }),
    ]);
    const segDuration = await this.prisma.videoSegment.aggregate({ _sum: { durationSec: true }, where: { project: base } });
    return toJSONSafe({
      projects,
      videosProcessed: processed,
      activeProcessing: active,
      clipsGenerated: clips,
      storageUsedBytes: user_.storageUsedBytes,
      storageQuotaBytes: user_.storageQuotaBytes,
      mediaDurationSec: (duration._sum.durationSec ?? 0) + (segDuration._sum.durationSec ?? 0),
      processingMs: processing._sum.processingMs ?? 0,
      recentProjects: recent,
    });
  }
}
