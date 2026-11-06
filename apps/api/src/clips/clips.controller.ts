import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { AspectRatio } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsEnum, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
import type { SubtitleStyle, ThumbnailStyle } from '@clipmaster/shared';
import { AuthUser, CurrentUser } from '../auth/auth.guard';
import { ClipsService } from './clips.service';

class UpdateClipDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) title?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsNumber() @Min(0) start?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsNumber() @Min(0) end?: number;
  @ApiPropertyOptional({ enum: AspectRatio }) @IsOptional() @IsEnum(AspectRatio) aspect?: AspectRatio;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() subtitles?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsObject() subtitleStyle?: Partial<SubtitleStyle>;
  @ApiPropertyOptional({ enum: ['auto', 'center', 'manual'] }) @IsOptional() @IsIn(['auto', 'center', 'manual']) reframeMode?: 'auto' | 'center' | 'manual';
  @ApiPropertyOptional() @IsOptional() @ValidateIf((_o, v) => v !== null) @IsNumber() @Min(0) @Max(1) manualX?: number | null;
  @ApiPropertyOptional() @IsOptional() @ValidateIf((_o, v) => v !== null) @IsNumber() @Min(0) @Max(1) manualY?: number | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() hookEnabled?: boolean;
  @ApiPropertyOptional() @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() @MaxLength(120) hookText?: string | null;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsNumber() @Min(1) @Max(10) hookDuration?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() aiEyeContact?: boolean;
  @ApiPropertyOptional() @IsOptional() @ValidateIf((_o, v) => v !== null) @IsInt() @Min(0) @Max(4) aiRelight?: number | null;
  @ApiPropertyOptional() @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() @MaxLength(80) hookVoice?: string | null;
  @ApiPropertyOptional() @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() @MaxLength(600) coverPrompt?: string | null;
}

class EditedWordDto {
  @IsNumber() start: number;
  @IsNumber() end: number;
  @IsString() @MaxLength(60) word: string;
}

class SetWordsDto {
  @IsArray() @ArrayMaxSize(3000) @ValidateNested({ each: true }) @Type(() => EditedWordDto) words: EditedWordDto[];
}

class MergeClipsDto {
  @IsArray() @ArrayMinSize(2) @ArrayMaxSize(10) @IsUUID('all', { each: true }) clipIds: string[];
  @IsOptional() @IsString() @MaxLength(200) title?: string;
}

class CreateClipDto {
  @Type(() => Number) @IsNumber() @Min(0) start: number;
  @Type(() => Number) @IsNumber() @Min(0) end: number;
  @IsOptional() @IsString() @MaxLength(200) title?: string;
}

class ThumbnailDto {
  @Type(() => Number) @IsNumber() @Min(0) at: number;
  @IsOptional() @IsEnum(AspectRatio) aspect?: AspectRatio;
  @IsOptional() @IsIn(['frame', 'ai']) background?: 'frame' | 'ai';
  @IsOptional() @IsBoolean() cutout?: boolean;
  @IsOptional() @ValidateIf((_o, v) => v !== null) @IsString() @MaxLength(600) prompt?: string | null;
  @IsOptional() @IsString() @MaxLength(120) text?: string;
  @IsOptional() @IsObject() style?: Partial<ThumbnailStyle>;
}

class ApplyStyleDto {
  @IsObject() style: Partial<SubtitleStyle>;
  @IsOptional() @IsBoolean() regenerate?: boolean;
}

@ApiTags('clips')
@Controller()
export class ClipsController {
  constructor(private readonly clips: ClipsService) {}

  @Get('clips')
  all(@CurrentUser() user: AuthUser, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.clips.listAll(user.id, Math.max(1, Number(page) || 1), Math.min(100, Math.max(1, Number(pageSize) || 24)));
  }

  @Get('projects/:projectId/clips')
  forProject(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.clips.listForProject(user.id, projectId);
  }

  @Get('projects/:projectId/moments')
  moments(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string, @Query('q') q?: string) {
    const query = (q ?? '').trim();
    if (query.length < 2 || query.length > 200) throw new BadRequestException('Escribe entre 2 y 200 caracteres');
    return this.clips.moments(user.id, projectId, query);
  }

  @Post('projects/:projectId/clips')
  create(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string, @Body() dto: CreateClipDto) {
    return this.clips.createManual(user.id, projectId, dto);
  }

  @HttpCode(200)
  @Post('clips/merge')
  merge(@CurrentUser() user: AuthUser, @Body() dto: MergeClipsDto) {
    return this.clips.merge(user.id, dto.clipIds, dto.title);
  }

  @HttpCode(200)
  @Post('projects/:projectId/apply-style')
  applyStyle(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string, @Body() dto: ApplyStyleDto) {
    return this.clips.applyStyleToProject(user.id, projectId, dto.style, dto.regenerate ?? true);
  }

  @Get('clips/:id/words')
  words(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.clips.words(user.id, id);
  }

  @Put('clips/:id/words')
  setWords(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetWordsDto) {
    return this.clips.setWords(user.id, id, dto.words);
  }

  @Delete('clips/:id/words')
  resetWords(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.clips.resetWords(user.id, id);
  }

  @Get('clips/:id')
  detail(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.clips.detail(user.id, id);
  }

  @Patch('clips/:id')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateClipDto) {
    return this.clips.update(user.id, id, dto);
  }

  @HttpCode(200)
  @HttpCode(200)
  @Post('clips/:id/copy')
  generateCopy(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.clips.generateCopy(user.id, id);
  }

  @HttpCode(200)
  @Post('clips/:id/thumbnail')
  thumbnail(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ThumbnailDto) {
    return this.clips.generateThumbnail(user.id, id, dto);
  }

  @Post('clips/:id/regenerate')
  regenerate(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.clips.regenerate(user.id, id);
  }

  @HttpCode(204)
  @Delete('clips/:id')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.clips.remove(user.id, id);
  }
}
