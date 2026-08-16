import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Get,
  Post,
  UploadedFiles,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import {
  MAX_UPLOAD_FILES,
  uploadVideoSchema,
  type UploadVideoInput,
} from '@video/shared';

import { VIDEO_EXTENSIONS } from '../ingest/path-parser';
import { diskStorage } from 'multer';

import type { AuthUser } from '../auth/auth.types';
import { CurrentUser, Roles } from '../auth/decorators';
import { maxUploadBytes, resolveRoot } from '../common/env';
import { validate } from '../common/zod-validation.pipe';
import { UPLOAD_STAGING_DIRECTORY, UploadsService, type UploadedVideoFile } from './uploads.service';
import { ThrottleExpensive } from '../common/throttling';

/**
 * Staging directory, resolved once at module load.
 *
 * Named with a leading dot so both the ingest scanner and the chokidar watcher
 * skip it — a half-uploaded file is never a candidate for ingestion.
 *
 * It sits at the top of `MEDIA_ROOT` rather than on the target drive, because
 * the drive is a field in the same multipart body and is not reliably parsed
 * before the first file arrives. The move out of here therefore crosses
 * filesystems whenever a drive is its own disk, which `StorageService.move`
 * handles by copying to a dot-prefixed neighbour and renaming into place — so a
 * file still appears under its final name only once it is complete.
 */
function stagingPath(): string {
  // Through `resolveRoot`, which `StorageService` also uses — this module cannot
  // reach that service (a decorator argument runs before DI exists), and the
  // second copy of the default it used to carry is exactly the one that must not
  // drift from the first.
  const staging = resolve(resolveRoot('media', process.env.MEDIA_ROOT), UPLOAD_STAGING_DIRECTORY);
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
    FilesInterceptor('file', MAX_UPLOAD_FILES, {
      storage: diskStorage({
        destination: (_request, _file, callback) => callback(null, stagingPath()),
        // A generated name, because the client's filename is not a path
        // component. The real name is applied when the file is moved into place.
        filename: (_request, _file, callback) =>
          callback(null, `${Date.now()}-${Math.random().toString(36).slice(2)}.part`),
      }),
      // From the environment, defaulting to the shared constant the browser also
      // checks against. Documented as configuration since the first release and
      // read for the first time here.
      limits: { fileSize: maxUploadBytes(), files: MAX_UPLOAD_FILES },
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
    @UploadedFiles() files: UploadedVideoFile[] | undefined,
    @Body(validate(uploadVideoSchema)) dto: UploadVideoInput,
    @CurrentUser() admin: AuthUser,
  ) {
    if (!files || files.length === 0) throw new BadRequestException('No video uploaded');

    /**
     * Relative paths are matched to files **by position**.
     *
     * A single-value field arrives as a string rather than an array, which is
     * the shape that quietly pairs every file with the same path; normalised
     * here so a one-file folder upload cannot land as a stack of overwrites.
     */
    const paths = dto.paths === undefined ? [] : [dto.paths].flat();

    return this.uploads.placeUpload(
      files.map((file, index) => ({ ...file, relativePath: paths[index] })),
      { drive: dto.drive },
      admin.id,
    );
  }

  /** The disks an upload can target. Named before anything can be sent. */
  @Get('upload/drives')
  async drives() {
    return { items: await this.uploads.listDrives() };
  }
}
