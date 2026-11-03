import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AspectRatio, ContentMode } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsInt, IsOptional, IsString, IsUrl, Length, Max, MaxLength, Min, Validate, ValidationArguments, ValidatorConstraint, ValidatorConstraintInterface } from 'class-validator';

const toBool = ({ value }: { value: unknown }) => (typeof value === 'string' ? ['true', '1', 'on'].includes(value) : value);

@ValidatorConstraint({ name: 'durationRange' })
class DurationRange implements ValidatorConstraintInterface {
  validate(max: number, args: ValidationArguments) {
    const min = (args.object as ProjectOptionsDto).minDuration ?? 15;
    return max >= min + 5;
  }
  defaultMessage() {
    return 'La duración máxima debe superar a la mínima en al menos 5 segundos';
  }
}

export class ProjectOptionsDto {
  @ApiProperty() @IsString() @Length(1, 120) name: string;
  @ApiPropertyOptional({ enum: ContentMode }) @IsOptional() @IsEnum(ContentMode) mode?: ContentMode;
  @ApiPropertyOptional({ description: 'Código ISO (es, en…) o vacío para detección automática' })
  @IsOptional() @IsString() @MaxLength(8) @Transform(({ value }) => (value === '' || value === 'auto' ? undefined : value)) language?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(50) maxClips?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(5) @Max(180) minDuration?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(10) @Max(300) @Validate(DurationRange) maxDuration?: number;
  @ApiPropertyOptional({ enum: AspectRatio }) @IsOptional() @IsEnum(AspectRatio) aspect?: AspectRatio;
  @ApiPropertyOptional() @IsOptional() @Transform(toBool) @IsBoolean() subtitles?: boolean;
  @ApiPropertyOptional() @IsOptional() @Transform(toBool) @IsBoolean() smartDetection?: boolean;
  @ApiPropertyOptional({ enum: ['balanced', 'quality', 'quantity'] }) @IsOptional() @IsIn(['balanced', 'quality', 'quantity']) preference?: string;
}

export class CreateUrlProjectDto extends ProjectOptionsDto {
  @ApiProperty() @IsUrl({ protocols: ['http', 'https'], require_protocol: true }) @MaxLength(2048) url: string;
  @ApiPropertyOptional({ description: 'Confirmación de que el usuario posee o está autorizado a procesar el contenido' })
  @Transform(toBool) @IsBoolean() authorized: boolean;
  @ApiPropertyOptional({ description: 'Capturar como directo si la fuente está en vivo' })
  @IsOptional() @Transform(toBool) @IsBoolean() captureLive?: boolean;
}

export class ValidateUrlDto {
  @ApiProperty() @IsUrl({ protocols: ['http', 'https'], require_protocol: true }) @MaxLength(2048) url: string;
}
