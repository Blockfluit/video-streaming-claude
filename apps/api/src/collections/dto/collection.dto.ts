import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
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

export class CreateCollectionDto {
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(5000)
  description?: string;

  // Bounded rather than open: a four-digit year is the only thing this means.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1888) // Roundhay Garden Scene
  @Max(2200)
  year?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  tags?: string[];

  /**
   * Folder under MEDIA_ROOT. Defaults to the generated slug.
   *
   * Accepted so an admin can attach a collection to a folder that already
   * exists on disk, which is how you adopt files that were copied in before
   * the collection was created.
   */
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  folderKey?: string;
}

export class UpdateCollectionDto {
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
  @Type(() => Number)
  @IsInt()
  @Min(1888)
  @Max(2200)
  year?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(50, { each: true })
  tags?: string[];

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(500)
  posterKey?: string;

  /**
   * Slugs are stable once created — renaming a title must not silently break
   * every link anyone has shared. Regenerating is therefore an explicit act,
   * not a side effect of editing the title.
   */
  @IsOptional()
  @IsBoolean()
  regenerateSlug?: boolean;
}
