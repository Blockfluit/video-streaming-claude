import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { MAX_UPLOAD_BYTES, uploadVideoSchema, type UploadVideoInput } from '@video/shared';

import { VIDEO_EXTENSIONS } from '../ingest/path-parser';
import { diskStorage } from 'multer';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';
import { validate } from '../common/zod-validation.pipe';
import { UPLOAD_STAGING_DIRECTORY, UploadsService, type UploadedVideoFile } from './uploads.service';
import { ThrottleExpensive } from '../common/throttling';

/**
 * Staging directory, resolved once at module load.
 *
 * Inside `MEDIA_ROOT` so the final move is a rename on the same filesystem
 * (across two mounts it would fail with `EXDEV`), and named with a leading dot
 * so both the ingest scanner and the chokidar watcher skip it — a half-uploaded
 * file is never a candidate for ingestion.
 */
function stagingPath(): string {
  const mediaRoot = resolve(process.cwd(), process.env.MEDIA_ROOT ?? '../../media');
  const staging = resolve(mediaRoot, UPLOAD_STAGING_DIRECTORY);
  mkdirSync(staging, { recursive: true });
  return staging;
}

@Controller('videos')
@Roles('ADMIN')
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  /**
   * `diskStorage`, never memory: a 2 GB file buffered in the heap would take
   * the process with it. multer streams it to disk as it arrives.
   */
  /** Writes gigabytes to disk. A loop here fills the drive. */
  @ThrottleExpensive()
  @Post('upload')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: (_request, _file, callback) => callback(null, stagingPath()),
        // A generated name, because the client's filename is not a path
        // component. The real name is applied when the file is moved into place.
        filename: (_request, _file, callback) =>
          callback(null, `${Date.now()}-${Math.random().toString(36).slice(2)}.part`),
      }),
      limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
      fileFilter: (_request, file, callback) => {
        // Judged on the extension only. The browser's `mimetype` comes from the
        // OS registry rather than the file, and is wrong often enough that
        // trusting it rejects real uploads.
        const ok = UploadsService.isAcceptable(file.originalname);
        callback(
          ok
            ? null
            : new BadRequestException(
                `Unsupported file type. Accepted: ${[...VIDEO_EXTENSIONS].join(', ')}`,
              ),
          ok,
        );
      },
    }),
  )
  async upload(
    @UploadedFile() file: UploadedVideoFile | undefined,
    @Body(validate(uploadVideoSchema)) dto: UploadVideoInput,
    @CurrentUser() admin: AuthUser,
  ) {
    if (!file) throw new BadRequestException('No video uploaded');

    return this.uploads.ingestUpload(file, dto, admin.id);
  }
}
