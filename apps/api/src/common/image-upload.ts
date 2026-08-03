import { BadRequestException } from '@nestjs/common';
import { MAX_THUMBNAIL_BYTES } from '@video/shared';

/**
 * Accepting an uploaded image, for videos and for collections.
 *
 * Moved out of `videos.controller.ts` when the collection editor became the
 * second caller. Two copies of "which image types are allowed" is how one screen
 * ends up accepting a format the other rejects, and the answer has to match the
 * `CONTENT_TYPES` that `ImagesService` will serve it back with.
 *
 * **The extension comes from the mime type, never from the client's filename.**
 * That name is metadata typed by whoever uploaded it and must never become a
 * path component; the mime type is at least something the browser derived.
 */

export const MIME_TO_EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * multer options for a single image.
 *
 * Must be referenced from **above** the controller class that uses it: a
 * decorator argument is evaluated when the class is defined, not when the route
 * runs, so a `const` declared below the class is still in its temporal dead
 * zone. Living in its own module makes that impossible to get wrong.
 */
export const IMAGE_UPLOAD = {
  limits: { fileSize: MAX_THUMBNAIL_BYTES, files: 1 },
  fileFilter: (
    _request: unknown,
    file: { mimetype: string },
    callback: (error: Error | null, acceptFile: boolean) => void,
  ) => {
    const extension = MIME_TO_EXTENSION[file.mimetype];
    callback(
      extension ? null : new BadRequestException('Unsupported image type'),
      Boolean(extension),
    );
  },
};
