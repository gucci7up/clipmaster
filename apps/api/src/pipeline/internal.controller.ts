import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { JobFailEvent, ProgressEvent, SegmentReadyEvent } from '@clipmaster/shared';
import { Internal } from '../auth/auth.guard';
import { PipelineService } from './pipeline.service';

/**
 * API interna para los workers (red Docker privada, token compartido).
 * Todos los endpoints son idempotentes: un worker puede repetir la llamada sin efectos dobles.
 */
@ApiExcludeController()
@SkipThrottle()
@Internal()
@Controller('internal')
export class InternalController {
  constructor(private readonly pipeline: PipelineService) {}

  @HttpCode(200)
  @Post('jobs/:id/start')
  start(@Param('id', ParseUUIDPipe) id: string) {
    return this.pipeline.onStart(id);
  }

  @HttpCode(204)
  @Post('jobs/:id/progress')
  async progress(@Param('id', ParseUUIDPipe) id: string, @Body() body: Omit<ProgressEvent, 'jobId'>) {
    await this.pipeline.onProgress({ ...body, jobId: id });
  }

  @HttpCode(200)
  @Post('jobs/:id/complete')
  complete(@Param('id', ParseUUIDPipe) id: string, @Body() body: { result: unknown }) {
    return this.pipeline.onComplete(id, body.result);
  }

  @HttpCode(204)
  @Post('jobs/:id/fail')
  async fail(@Param('id', ParseUUIDPipe) id: string, @Body() body: Omit<JobFailEvent, 'jobId'>) {
    await this.pipeline.onFail(id, String(body.error ?? 'Error desconocido'), Boolean(body.willRetry), Number(body.attempt ?? 1));
  }

  @HttpCode(200)
  @Post('captures/:id/segments')
  segment(@Param('id', ParseUUIDPipe) id: string, @Body() body: Omit<SegmentReadyEvent, 'captureSessionId'>) {
    return this.pipeline.onSegment({ ...body, captureSessionId: id });
  }
}
