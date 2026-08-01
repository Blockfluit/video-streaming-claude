import { BadRequestException } from '@nestjs/common';

/**
 * What every image upload in the app agrees on.
 *
 * This lived at the bottom of `videos.controller.ts` while the poster was the
 * only thing anyone could upload. Banners on videos and on collections make
 * three callers, and a rule about which files are acceptable is not something
 * to hold three copies of.
 *
 * multer buffers these in memory rather than using `diskStorage`, which
 * contradicts the rule for the 2 GB video upload path and is deliberate here:
 * an image is small, it goes straight to `StorageService.save`, and there is
 * nothing to gain from a temp file. The **byte cap is what makes that safe**,
 * so a route using this filter without a `limits.fileSize` is a heap
 * exhaustion waiting to happen.
 */

/** Extension taken from the mime type, never from the client's filename. */
export const MIME_TO_EXTENSION: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** The extension for an upload's mime type, or null when we will not take it. */
export function imageExtensionFor(mimetype: string): string | null {
  return MIME_TO_EXTENSION[mimetype] ?? null;
}

/**
 * multer's `fileFilter`, shared by every image route.
 *
 * The client's filename never reaches a path segment. It arrives from the
 * browser, and multer strips directory separators but not a leading dot, so
 * deriving an extension from it is a way to end up with a file the scanner
 * skips — or worse.
 */
export const imageFileFilter = (
  _request: unknown,
  file: { mimetype: string },
  callback: (error: Error | null, acceptFile: boolean) => void,
): void => {
  const extension = imageExtensionFor(file.mimetype);
  callback(extension ? null : new BadRequestException('Unsupported image type'), Boolean(extension));
};

/**
 * Where banners live under DERIVED_ROOT.
 *
 * Namespaced by owner because a video and a collection are different tables
 * with independently generated ids — `banners/<id>` would work today and be a
 * silent collision the day anything else grows a banner.
 *
 * It lives here rather than beside the writer in `media.service` because both
 * `MediaService` and `CollectionsService` need it, and having the collection
 * reach into the media module for it made a circular import that broke the
 * API at boot.
 */
export function bannerKeyFor(owner: 'videos' | 'collections', id: string, extension: string): string {
  return `banners/${owner}/${id}.${extension}`;
}
