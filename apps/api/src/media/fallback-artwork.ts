import type { ArtworkShape } from './artwork';

/**
 * The picture shown when there is no other.
 *
 * Built in code rather than shipped as a file. `nest build` copies TypeScript
 * and nothing else, so a `.jpg` here would need an `assets` entry in
 * `nest-cli.json` *and* a `COPY` in the Dockerfile — and when either is missed
 * the failure is a 500 in production and nowhere else, which is the worst place
 * to find out. A string has no build step to forget.
 *
 * SVG also stays sharp at any size, which matters because the same two images
 * are drawn as a 176px card and as a full-width backdrop.
 *
 * The colours are the app's own surface tokens, resolved to hex: this is served
 * to an `<img>`, so it gets no stylesheet and cannot read a CSS variable.
 */

const BACKGROUND = '#111114';
const MARK = '#3f3f46';

/** 2:3 and 16:9 at the same nominal scale as a real capture. */
const DIMENSIONS: Record<ArtworkShape, { width: number; height: number }> = {
  poster: { width: 400, height: 600 },
  banner: { width: 640, height: 360 },
};

/**
 * A clapperboard, centred, at a size that reads on both shapes.
 *
 * Deliberately the same mark the frontend draws when an image fails, so a
 * missing picture looks like one thing across the app rather than like two
 * different bugs.
 */
function clapperboard(cx: number, cy: number, size: number): string {
  const half = size / 2;
  return [
    `<g transform="translate(${cx - half} ${cy - half}) scale(${size / 24})" fill="none"`,
    ` stroke="${MARK}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">`,
    '<path d="M20.2 6 3 11.1v9.4a1.5 1.5 0 0 0 1.5 1.5h15a1.5 1.5 0 0 0 1.5-1.5V7.5A1.5 1.5 0 0 0 19.5 6z"/>',
    '<path d="m6.2 5.3 3.1 3.9"/><path d="m12.4 3.4 3.1 4"/>',
    '<path d="M3 11.1 21 6.4"/>',
    '<path d="m2.5 8.7.6-2.2a1.5 1.5 0 0 1 1.8-1.1l14.5 3.9a1.5 1.5 0 0 1 1.1 1.8l-.6 2.2z"/>',
    '</g>',
  ].join('');
}

const CACHE = new Map<ArtworkShape, Buffer>();

/** The bytes to serve. Built once — it is the same picture every time. */
export function fallbackArtwork(shape: ArtworkShape): Buffer {
  const cached = CACHE.get(shape);
  if (cached) return cached;

  const { width, height } = DIMENSIONS[shape];
  const svg
    = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" `
      + `viewBox="0 0 ${width} ${height}" role="img" aria-label="No artwork">`
      + `<rect width="${width}" height="${height}" fill="${BACKGROUND}"/>`
      + clapperboard(width / 2, height / 2, Math.min(width, height) * 0.28)
      + '</svg>';

  const bytes = Buffer.from(svg, 'utf8');
  CACHE.set(shape, bytes);
  return bytes;
}

export const FALLBACK_CONTENT_TYPE = 'image/svg+xml';
