import { BadRequestException, Controller, ForbiddenException, Get, Headers, NotFoundException, Param, ParseUUIDPipe, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Readable } from 'node:stream';
import { Public } from '../auth/auth.guard';
import { PrismaService } from '../common/prisma.service';
import { verifyMedia } from '../common/signing';
import { StorageService } from '../common/storage.service';
import { env } from '../config/env';
import type { MediaKind } from './media.service';

const KINDS: MediaKind[] = ['original', 'render', 'thumb', 'cover', 'clipthumb', 'segment', 'subtitle'];

/**
 * Sirve medios privados de MinIO a través de la API con URLs firmadas y soporte Range,
 * para reproducción en <video> y descargas, sin exponer el almacenamiento.
 */
@ApiTags('media')
@SkipThrottle()
@Controller('media')
export class MediaController {
  constructor(private readonly prisma: PrismaService, private readonly storage: StorageService) {}

  @Public()
  @Get(':kind/:id')
  async serve(
    @Param('kind') kind: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('exp') exp: string,
    @Query('sig') sig: string,
    @Query('dl') dl: string | undefined,
    @Headers('range') range: string | undefined,
    @Res() res: Response,
  ) {
    if (!KINDS.includes(kind as MediaKind)) throw new BadRequestException('Tipo de medio inválido');
    if (!verifyMedia(env().MEDIA_SIGNING_SECRET, `${kind}:${id}`, Number(exp), sig)) {
      throw new ForbiddenException('Enlace inválido o caducado');
    }
    const { key, contentType, filename } = await this.resolve(kind as MediaKind, id);
    if (range && !/^bytes=\d*-\d*$/.test(range)) throw new BadRequestException('Range inválido');

    let obj;
    try {
      obj = await this.storage.getStream(key, range);
    } catch {
      throw new NotFoundException('Archivo no disponible');
    }
    res.status(range && obj.ContentRange ? 206 : 200);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (obj.ContentLength != null) res.setHeader('Content-Length', String(obj.ContentLength));
    if (obj.ContentRange) res.setHeader('Content-Range', obj.ContentRange);
    if (dl) res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    (obj.Body as Readable).on('error', () => res.destroy()).pipe(res);
  }

  private async resolve(kind: MediaKind, id: string): Promise<{ key: string; contentType: string; filename: string }> {
    switch (kind) {
      case 'original': {
        const a = await this.prisma.videoAsset.findUnique({ where: { id } });
        if (!a) break;
        return { key: a.storageKey, contentType: 'video/mp4', filename: `original-${id.slice(0, 8)}.mp4` };
      }
      case 'segment': {
        const s = await this.prisma.videoSegment.findUnique({ where: { id } });
        if (!s) break;
        return { key: s.storageKey, contentType: 'video/mp4', filename: `segmento-${s.index}.mp4` };
      }
      case 'render':
      case 'thumb':
      case 'cover': {
        const r = await this.prisma.clipRender.findUnique({ where: { id }, include: { clip: true } });
        const key = kind === 'render' ? r?.outputKey : kind === 'cover' ? r?.coverKey : r?.thumbnailKey;
        if (!r || !key || r.clip.deletedAt) break;
        const safeTitle = r.clip.title.normalize('NFKD').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'clip';
        return kind === 'render'
          ? { key, contentType: 'video/mp4', filename: `${safeTitle}.mp4` }
          : { key, contentType: 'image/jpeg', filename: `${safeTitle}${kind === 'cover' ? '-portada' : ''}.jpg` };
      }
      case 'clipthumb': {
        const c = await this.prisma.clip.findUnique({ where: { id } });
        if (!c?.thumbKey || c.deletedAt) break;
        const safeTitle = c.title.normalize('NFKD').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'clip';
        return { key: c.thumbKey, contentType: 'image/jpeg', filename: `${safeTitle}-miniatura.jpg` };
      }
      case 'subtitle': {
        const t = await this.prisma.subtitleTrack.findUnique({ where: { id } });
        if (!t) break;
        return { key: t.storageKey, contentType: 'text/plain; charset=utf-8', filename: `subtitulos-${id.slice(0, 8)}.${t.format}` };
      }
    }
    throw new NotFoundException('Medio no encontrado');
  }
}
