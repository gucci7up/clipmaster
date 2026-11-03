import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { AspectRatio } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsNumber, IsObject, IsOptional, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import type { SubtitleStyle } from '@clipmaster/shared';
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

  @Get('clips/:id')
  detail(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.clips.detail(user.id, id);
  }

  @Patch('clips/:id')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateClipDto) {
    return this.clips.update(user.id, id, dto);
  }

  @HttpCode(200)
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
