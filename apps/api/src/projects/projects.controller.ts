import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { diskStorage } from 'multer';
import { AuthUser, CurrentUser } from '../auth/auth.guard';
import { env } from '../config/env';
import { SourcesService } from '../sources/sources.service';
import { CreateUrlProjectDto, ProjectOptionsDto, ValidateUrlDto } from './projects.dto';
import { ProjectsService } from './projects.service';

const uploadDir = () => {
  const dir = env().UPLOAD_TMP_DIR;
  mkdirSync(dir, { recursive: true });
  return dir;
};

@ApiTags('projects')
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService, private readonly sources: SourcesService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.projects.list(user.id, { status, search, page: Number(page) || 1, pageSize: Number(pageSize) || 20 });
  }

  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(200)
  @Post('validate-url')
  validate(@Body() dto: ValidateUrlDto) {
    return this.sources.validate(dto.url);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post()
  createFromUrl(@CurrentUser() user: AuthUser, @Body() dto: CreateUrlProjectDto, @Req() req: Request) {
    return this.projects.createFromUrl(user.id, dto, req.ip);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('upload')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, name: { type: 'string' } } } })
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_req, _file, cb) => cb(null, uploadDir()),
        // Nombre aleatorio: nunca se usa el nombre del cliente en disco.
        filename: (_req, _file, cb) => cb(null, `${randomUUID()}.upload`),
      }),
      limits: { fileSize: env().MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 20 },
    }),
  )
  async upload(@CurrentUser() user: AuthUser, @UploadedFile() file: Express.Multer.File | undefined, @Body() dto: ProjectOptionsDto, @Req() req: Request) {
    if (!file) throw new BadRequestException('Falta el archivo de video');
    return this.projects.createFromUpload(user.id, dto, file, req.ip);
  }

  @Get(':id')
  detail(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.projects.detail(user.id, id);
  }

  @Get(':id/events')
  events(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Query('limit') limit?: string) {
    return this.projects.events(user.id, id, Number(limit) || 100);
  }

  @Get(':id/transcript')
  transcript(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.projects.transcript(user.id, id);
  }

  @Get(':id/candidates')
  candidates(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.projects.candidates(user.id, id);
  }

  @HttpCode(200)
  @Post(':id/cancel')
  cancel(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.projects.cancel(user.id, id);
  }

  @HttpCode(200)
  @Post(':id/stop-capture')
  stop(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.projects.stopCapture(user.id, id);
  }

  @HttpCode(200)
  @Post(':id/retry')
  retry(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.projects.retry(user.id, id);
  }

  @HttpCode(204)
  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.projects.remove(user.id, id);
  }
}
