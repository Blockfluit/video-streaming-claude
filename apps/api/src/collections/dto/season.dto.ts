import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const trimmed = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreateSeasonDto {
  @IsString()
  @MinLength(1)
  collectionId!: string;

  /** Optional: "Specials" is a season with no number, and the parser flags those rather than guessing. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0) // season 0 is the conventional home for specials
  @Max(999)
  number?: number;

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(5000)
  description?: string;

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  folderKey?: string;
}

export class UpdateSeasonDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(999)
  number?: number;

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(5000)
  description?: string;

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(500)
  posterKey?: string;

  @IsOptional()
  @IsBoolean()
  regenerateSlug?: boolean;
}
