import { Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Patch, Put } from '@nestjs/common';
import { ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { AspectRatio, ContentMode, Prisma, Role } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsInt, IsObject, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { MODES, PROVIDERS, SignalWeights, SubtitleStyle } from '@clipmaster/shared';
import { AuthUser, CurrentUser, Roles } from '../auth/auth.guard';
import { AuditService } from '../common/audit.service';
import { PrismaService } from '../common/prisma.service';
import { RedisService } from '../common/redis.service';
import { toJSONSafe } from '../common/json';
import { sanitizeStyle } from '../clips/clips.service';

const SIGNALS = ['semantic', 'emotion', 'audio', 'visual', 'chat', 'narrative', 'standalone'] as const;

class UpdateSettingsDto {
  @ApiPropertyOptional({ enum: ContentMode }) @IsOptional() @IsEnum(ContentMode) defaultMode?: ContentMode;
  @ApiPropertyOptional({ enum: AspectRatio }) @IsOptional() @IsEnum(AspectRatio) defaultAspect?: AspectRatio;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(8) defaultLanguage?: string;
  @ApiPropertyOptional() @IsOptional() @IsIn(['system', 'light', 'dark']) theme?: string;
  @ApiPropertyOptional() @IsOptional() @IsObject() subtitleStyle?: Partial<SubtitleStyle>;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() hookTitles?: boolean;
}

class UpdateAiSettingsDto {
  @ApiPropertyOptional() @IsOptional() @IsObject() weights?: SignalWeights | null;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() visualAnalysis?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() semanticLLM?: boolean;
}

class AdminUpdateUserDto {
  @ApiPropertyOptional({ enum: Role }) @IsOptional() @IsEnum(Role) role?: Role;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() disabled?: boolean;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100000) quotaGb?: number;
}

@ApiTags('settings')
@Controller()
export class SettingsController {
  constructor(private readonly prisma: PrismaService, private readonly audit: AuditService, private readonly redis: RedisService) {}

  @Get('settings')
  async get(@CurrentUser() user: AuthUser) {
    const [settings, ai] = await Promise.all([
      this.prisma.userSettings.upsert({ where: { userId: user.id }, create: { userId: user.id }, update: {} }),
      this.prisma.aISettings.upsert({ where: { userId: user.id }, create: { userId: user.id }, update: {} }),
    ]);
    return { settings, ai, llmProvider: await this.llmProvider() };
  }

  /**
   * Proveedor LLM que anuncian los ai-workers en su heartbeat ("ollama:<modelo>", "nvidia:<modelo>" o null).
   * Se muestra en Ajustes para que el usuario sepa si los fragmentos de transcripción salen del servidor.
   */
  private async llmProvider(): Promise<string | null> {
    try {
      const keys: string[] = [];
      let cursor = '0';
      do {
        const [next, batch] = await this.redis.client.scan(cursor, 'MATCH', 'clipmaster:worker:*', 'COUNT', 100);
        cursor = next;
        keys.push(...batch);
      } while (cursor !== '0');
      const values = keys.length ? await this.redis.client.mget(keys) : [];
      for (const v of values) {
        const llm = v ? (JSON.parse(v) as { llm?: string | null }).llm : null;
        if (llm) return llm;
      }
    } catch {
      /* Redis no disponible: se informa como sin proveedor */
    }
    return null;
  }

  @Put('settings')
  async update(@CurrentUser() user: AuthUser, @Body() dto: UpdateSettingsDto) {
    const data = {
      defaultMode: dto.defaultMode,
      defaultAspect: dto.defaultAspect,
      defaultLanguage: dto.defaultLanguage === '' ? null : dto.defaultLanguage,
      theme: dto.theme,
      subtitleStyle: dto.subtitleStyle ? (sanitizeStyle(dto.subtitleStyle) as Prisma.InputJsonValue) : undefined,
      hookTitles: dto.hookTitles,
    };
    return this.prisma.userSettings.upsert({ where: { userId: user.id }, create: { userId: user.id, ...data }, update: data });
  }

  @Put('settings/ai')
  async updateAi(@CurrentUser() user: AuthUser, @Body() dto: UpdateAiSettingsDto) {
    let weights: Prisma.InputJsonValue | typeof Prisma.DbNull | undefined;
    if (dto.weights === null) weights = Prisma.DbNull;
    else if (dto.weights) {
      const clean: Record<string, number> = {};
      for (const k of SIGNALS) {
        const v = Number((dto.weights as Record<string, unknown>)[k]);
        if (Number.isFinite(v)) clean[k] = Math.max(0, Math.min(1, v));
      }
      weights = clean;
    }
    const data = { weights, visualAnalysis: dto.visualAnalysis, semanticLLM: dto.semanticLLM };
    const saved = await this.prisma.aISettings.upsert({ where: { userId: user.id }, create: { userId: user.id, ...data }, update: data });
    await this.audit.log(user.id, 'settings.ai_updated', user.id);
    return saved;
  }

  /** Catálogo público de modos y proveedores (para el formulario de nuevo proyecto). */
  @Get('catalog')
  catalog() {
    return { modes: MODES, providers: PROVIDERS };
  }

  @Roles(Role.ADMIN)
  @Get('admin/users')
  async users() {
    const users = await this.prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      select: { id: true, email: true, name: true, role: true, disabled: true, storageUsedBytes: true, storageQuotaBytes: true, createdAt: true, _count: { select: { projects: true } } },
    });
    return toJSONSafe(users);
  }

  @Roles(Role.ADMIN)
  @Patch('admin/users/:id')
  async updateUser(@CurrentUser() admin: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminUpdateUserDto) {
    const exists = await this.prisma.user.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Usuario no encontrado');
    const user = await this.prisma.user.update({
      where: { id },
      data: {
        role: dto.role,
        disabled: dto.disabled,
        storageQuotaBytes: dto.quotaGb ? BigInt(dto.quotaGb) * 1024n ** 3n : undefined,
      },
      select: { id: true, email: true, role: true, disabled: true, storageQuotaBytes: true },
    });
    if (dto.disabled) await this.prisma.session.deleteMany({ where: { userId: id } });
    await this.audit.log(admin.id, 'admin.user_updated', id, null, { ...dto });
    return toJSONSafe(user);
  }
}
