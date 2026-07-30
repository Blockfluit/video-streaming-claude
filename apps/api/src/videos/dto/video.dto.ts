import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import type { PublishState } from '../../prisma/generated/enums';

const trimmed = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class ListVideosDto {
  @IsOptional()
  @IsIn(['DRAFT', 'PUBLISHED', 'ARCHIVED', 'MISSING'])
  state?: PublishState;

  @IsOptional()
  @IsString()
  collectionId?: string;

  /** Free-text search over title and description. */
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  tag?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  take?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skip?: number;
}

/**
 * Metadata only. Nothing here touches `storageKey`, `contentTag` or the probed
 * fields — those describe the file on disk, and are owned by ingest and probing
 * rather than by whoever is editing the page.
 */
export class UpdateVideoDto {
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  title?: string;

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(10000)
  description?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  tags?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100000)
  orderIndex?: number;

  /** Moves the video between seasons of the same collection, or out of a season entirely. */
  @IsOptional()
  @IsString()
  seasonId?: string | null;

  @IsOptional()
  @IsBoolean()
  regenerateSlug?: boolean;
}
