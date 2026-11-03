import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Post, Put, Req } from '@nestjs/common';
import { ApiExcludeController, ApiProperty, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { CaptureAgent, JobStatus, ProjectStatus, Role } from '@prisma/client';
import type { ImportJobData, ImportResult, ProgressEvent } from '@clipmaster/shared';
import { IsString, Length } from 'class-validator';
import type { Request } from 'express';
import { AgentOnly, AuthUser, CurrentAgent, CurrentUser, Roles } from '../auth/auth.guard';
import { AuditService } from '../common/audit.service';
import { RedisService } from '../common/redis.service';
import { StorageService } from '../common/storage.service';
import { env } from '../config/env';
import { PipelineService } from '../pipeline/pipeline.service';
import { AgentsService, expectedUploadKey, LEASE_SEC } from './agents.service';

/** S3 exige al menos 5 MiB por parte salvo la última; el capturador usa 8 MiB. */
const MIN_PART_BYTES = 5 * 1024 * 1024;
const MAX_PARTS = 10_000;

const uploadKey = (jobId: string) => `clipmaster:agent:upload:${jobId}`;

class CreateAgentDto {
  @ApiProperty({ example: 'PC de casa' }) @IsString() @Length(1, 80) name: string;
}

/** Gestión de capturadores (administradores). */
@ApiTags('admin')
@Roles(Role.ADMIN)
@Controller('admin/capture-agents')
export class AgentsAdminController {
  constructor(private readonly agents: AgentsService, private readonly audit: AuditService) {}

  @Get()
  list() {
    return this.agents.list();
  }

  @Post()
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateAgentDto) {
    const created = await this.agents.create(user.id, dto.name);
    await this.audit.log(user.id, 'admin.agent_created', created.agent.id, null, { name: dto.name });
    return created;
  }

  @HttpCode(204)
  @Delete(':id')
  async revoke(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.agents.revoke(id);
    await this.audit.log(user.id, 'admin.agent_revoked', id);
  }
}

/**
 * API para capturadores remotos (por el dominio público, token de capturador).
 * Reutiliza los manejadores de la API interna, pero cada llamada comprueba que el trabajo
 * está asignado a este capturador, y la subida sólo admite la clave de salida esperada.
 */
@ApiExcludeController()
@SkipThrottle()
@AgentOnly()
@Controller('capture-agent')
export class AgentsController {
  constructor(
    private readonly agents: AgentsService,
    private readonly pipeline: PipelineService,
    private readonly storage: StorageService,
    private readonly redis: RedisService,
  ) {}

  @HttpCode(200)
  @Post('hello')
  hello(@CurrentAgent() agent: CaptureAgent) {
    return { name: agent.name, leaseSec: LEASE_SEC, partBytes: 8 * 1024 * 1024 };
  }

  @HttpCode(200)
  @Post('claim')
  async claim(@CurrentAgent() agent: CaptureAgent) {
    return { job: await this.agents.claim(agent) };
  }

  @HttpCode(200)
  @Post('jobs/:id/start')
  async start(@CurrentAgent() agent: CaptureAgent, @Param('id', ParseUUIDPipe) id: string) {
    await this.agents.assertOwner(agent, id);
    return this.pipeline.onStart(id);
  }

  /** Además de registrar el progreso, informa de si el usuario canceló el proyecto. */
  @HttpCode(200)
  @Post('jobs/:id/progress')
  async progress(@CurrentAgent() agent: CaptureAgent, @Param('id', ParseUUIDPipe) id: string, @Body() body: Omit<ProgressEvent, 'jobId'>) {
    const job = await this.agents.assertOwner(agent, id);
    const cancelled = job.status === JobStatus.CANCELLED || job.project.status === ProjectStatus.CANCELLED || Boolean(job.project.deletedAt);
    if (!cancelled && body?.stage) await this.pipeline.onProgress({ ...body, jobId: id });
    return { cancelled };
  }

  @HttpCode(200)
  @Post('jobs/:id/upload/init')
  async uploadInit(@CurrentAgent() agent: CaptureAgent, @Param('id', ParseUUIDPipe) id: string, @Body() body: { key?: string }) {
    const job = await this.agents.assertOwner(agent, id);
    const key = expectedUploadKey(job.payload as unknown as ImportJobData);
    if (body?.key !== key) throw new BadRequestException('Clave de subida no permitida');
    const previous = await this.redis.client.hget(uploadKey(id), 'uploadId');
    if (previous) await this.storage.abortMultipart(key, previous);
    const uploadId = await this.storage.createMultipart(key, 'video/mp4');
    await this.redis.client.del(uploadKey(id));
    await this.redis.client.hset(uploadKey(id), { uploadId, key });
    await this.redis.client.expire(uploadKey(id), 86400);
    return { ok: true };
  }

  @HttpCode(200)
  @Put('jobs/:id/upload/parts/:n')
  async uploadPart(
    @CurrentAgent() agent: CaptureAgent,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('n', ParseIntPipe) n: number,
    @Req() req: Request,
  ) {
    await this.agents.assertOwner(agent, id);
    const state = await this.redis.client.hgetall(uploadKey(id));
    if (!state.uploadId) throw new BadRequestException('Subida no iniciada');
    if (n < 1 || n > MAX_PARTS) throw new BadRequestException('Número de parte inválido');
    const body = req.body as unknown;
    if (!Buffer.isBuffer(body) || body.length === 0) throw new BadRequestException('Parte vacía o con Content-Type incorrecto');
    const etag = await this.storage.uploadPart(state.key, state.uploadId, n, body);
    await this.redis.client.hset(uploadKey(id), `part:${n}`, `${etag}|${body.length}`);
    return { ok: true };
  }

  @HttpCode(200)
  @Post('jobs/:id/upload/finish')
  async uploadFinish(@CurrentAgent() agent: CaptureAgent, @Param('id', ParseUUIDPipe) id: string, @Body() body: { parts?: number }) {
    await this.agents.assertOwner(agent, id);
    const state = await this.redis.client.hgetall(uploadKey(id));
    if (!state.uploadId) throw new BadRequestException('Subida no iniciada');
    const total = Number(body?.parts);
    if (!Number.isInteger(total) || total < 1 || total > MAX_PARTS) throw new BadRequestException('Número de partes inválido');
    const parts: { PartNumber: number; ETag: string }[] = [];
    for (let n = 1; n <= total; n++) {
      const entry = state[`part:${n}`];
      if (!entry) throw new BadRequestException(`Falta la parte ${n}`);
      const [etag, size] = entry.split('|');
      if (n < total && Number(size) < MIN_PART_BYTES) throw new BadRequestException(`La parte ${n} es demasiado pequeña`);
      parts.push({ PartNumber: n, ETag: etag });
    }
    await this.storage.completeMultipart(state.key, state.uploadId, parts);
    await this.redis.client.del(uploadKey(id));
    const head = await this.storage.head(state.key);
    return { sizeBytes: head?.size ?? 0 };
  }

  @HttpCode(200)
  @Post('jobs/:id/complete')
  async complete(@CurrentAgent() agent: CaptureAgent, @Param('id', ParseUUIDPipe) id: string, @Body() body: { result?: ImportResult }) {
    const job = await this.agents.assertOwner(agent, id);
    const key = expectedUploadKey(job.payload as unknown as ImportJobData);
    const asset = body?.result?.asset;
    if (!asset || asset.key !== key) throw new BadRequestException('Resultado inválido');
    // El tamaño se toma del almacenamiento, no del capturador.
    const head = await this.storage.head(key);
    if (!head) throw new BadRequestException('El video no se subió');
    const out = await this.pipeline.onComplete(id, { ...body.result, asset: { ...asset, sizeBytes: head.size } });
    await this.agents.release(id);
    return out;
  }

  /** El servidor decide si se reintenta: errores del usuario no; transitorios hasta JOB_ATTEMPTS. */
  @HttpCode(204)
  @Post('jobs/:id/fail')
  async fail(@CurrentAgent() agent: CaptureAgent, @Param('id', ParseUUIDPipe) id: string, @Body() body: { error?: string; userError?: boolean }) {
    const job = await this.agents.assertOwner(agent, id);
    const attempt = Math.max(1, job.attempts);
    const willRetry = !body?.userError && attempt < env().JOB_ATTEMPTS;
    await this.pipeline.onFail(id, String(body?.error ?? 'Error desconocido').slice(0, 1500), willRetry, attempt);
    if (willRetry) await this.agents.requeue(id);
    await this.agents.release(id);
  }
}
