import { BadRequestException, Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { DEFAULT_SUBTITLE_STYLE, SubtitleStyle } from '@clipmaster/shared';
import { IsObject, IsString, Length } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { memoryStorage } from 'multer';
import { AuthUser, CurrentUser } from '../auth/auth.guard';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../common/prisma.service';
import { StorageService } from '../common/storage.service';
import { ClipsService, sanitizeStyle } from './clips.service';
import { fontExtension, fontFamily } from './font-file';

const MAX_PRESETS = 30;
const MAX_FONTS = 20;
const MAX_FONT_BYTES = 10 * 1024 * 1024;

class CreatePresetDto {
  @IsString() @Length(1, 60) name: string;
  @IsObject() style: Partial<SubtitleStyle>;
}

/** Estilos de subtítulos guardados y fuentes propias del usuario. */
@ApiTags('clips')
@Controller()
export class StylesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly clips: ClipsService,
    private readonly audit: AuditService,
  ) {}

  @Get('subtitle-presets')
  presets(@CurrentUser() user: AuthUser) {
    return this.prisma.subtitlePreset.findMany({ where: { userId: user.id }, orderBy: { createdAt: 'desc' } });
  }

  @Post('subtitle-presets')
  async createPreset(@CurrentUser() user: AuthUser, @Body() dto: CreatePresetDto) {
    if ((await this.prisma.subtitlePreset.count({ where: { userId: user.id } })) >= MAX_PRESETS) {
      throw new BadRequestException(`Máximo ${MAX_PRESETS} estilos guardados`);
    }
    if (dto.style.font) await this.clips.assertFont(user.id, dto.style.font);
    const style = { ...DEFAULT_SUBTITLE_STYLE, ...sanitizeStyle(dto.style) };
    return this.prisma.subtitlePreset.create({
      data: { userId: user.id, name: dto.name.trim(), style: style as unknown as Prisma.InputJsonValue },
    });
  }

  @HttpCode(204)
  @Delete('subtitle-presets/:id')
  async deletePreset(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const { count } = await this.prisma.subtitlePreset.deleteMany({ where: { id, userId: user.id } });
    if (!count) throw new NotFoundException('Estilo no encontrado');
  }

  @Get('fonts')
  fonts(@CurrentUser() user: AuthUser) {
    return this.prisma.userFont.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, family: true, fileName: true, sizeBytes: true, createdAt: true },
    });
  }

  @Post('fonts')
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } } })
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_FONT_BYTES, files: 1, fields: 2 } }))
  async uploadFont(@CurrentUser() user: AuthUser, @UploadedFile() file: Express.Multer.File | undefined) {
    if (!file?.buffer?.length) throw new BadRequestException('Falta el archivo de la fuente');
    const ext = fontExtension(file.buffer);
    if (!ext) throw new BadRequestException('El archivo no es una fuente TrueType u OpenType (.ttf / .otf)');
    const family = fontFamily(file.buffer);
    if (!family) throw new BadRequestException('No se pudo leer el nombre de la fuente');
    if ((await this.prisma.userFont.count({ where: { userId: user.id } })) >= MAX_FONTS) {
      throw new BadRequestException(`Máximo ${MAX_FONTS} fuentes`);
    }
    // Clave generada por el servidor; el nombre del archivo del cliente sólo se muestra.
    const key = `fonts/${user.id}/${randomUUID()}.${ext}`;
    await this.storage.uploadStream(key, Readable.from(file.buffer), ext === 'otf' ? 'font/otf' : 'font/ttf');
    const font = await this.prisma.userFont.create({
      data: {
        userId: user.id,
        family,
        fileName: (file.originalname || `fuente.${ext}`).replace(/[^\p{L}\p{N} ._()-]/gu, '').slice(0, 120),
        storageKey: key,
        sizeBytes: file.size,
      },
      select: { id: true, family: true, fileName: true, sizeBytes: true, createdAt: true },
    });
    await this.audit.log(user.id, 'font.uploaded', font.id, null, { family });
    return font;
  }

  @HttpCode(204)
  @Delete('fonts/:id')
  async deleteFont(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    const font = await this.prisma.userFont.findFirst({ where: { id, userId: user.id } });
    if (!font) throw new NotFoundException('Fuente no encontrada');
    await this.prisma.userFont.delete({ where: { id } });
    await this.storage.delete(font.storageKey);
    await this.audit.log(user.id, 'font.deleted', id);
  }
}
