/**
 * The two shapes of artwork, and how each is cut from a frame.
 *
 * Both come from the **same** capture — one frame 10% into the file — because
 * asking ffmpeg for two frames means two seeks through a multi-gigabyte file to
 * produce two pictures of the same moment. The banner is that frame; the poster
 * is a 2:3 crop of it.
 *
 * Pure, so the filter strings can be tested without a video file. That matters
 * more than it looks: a wrong crop expression makes ffmpeg fail on *some*
 * inputs only, which is the kind of bug that ships.
 */

export type ArtworkShape = 'poster' | 'banner';

export const ARTWORK_SHAPES: readonly ArtworkShape[] = ['poster', 'banner'] as const;

/**
 * Where the file lives under `DERIVED_ROOT` — `posters/` and `banners/`.
 *
 * The banner briefly kept the old `thumbnails/` directory, so that renaming the
 * column would not strand the files it addressed. Nothing is deployed yet, and a
 * poster has to be generated for every existing row regardless, so the reprobe
 * that does that also rewrites these keys. Two directories named after what is
 * in them beats one directory named after what it used to hold.
 */
export function artworkDirectory(shape: ArtworkShape): string {
  return `${shape}s`;
}

export function artworkKey(shape: ArtworkShape, videoId: string): string {
  return `${artworkDirectory(shape)}/${videoId}.jpg`;
}

/**
 * The `-vf` chain for a shape.
 *
 * The banner is the frame as captured, scaled to a card-sized width. `-2` keeps
 * the aspect and rounds to an even number, which some JPEG encoders insist on.
 *
 * The poster is a **centre crop** to 2:3, and the pair of `min`s is load-bearing.
 * The obvious expression is `crop=ih*2/3:ih` — take the full height and the 2:3
 * slice of width — and it is correct only while the source is landscape. A
 * portrait source (1080×1920, which phone video and some extras genuinely are)
 * asks that for a 1280px-wide crop out of 1080px, and ffmpeg refuses the whole
 * command rather than clamping.
 *
 * Taking the largest 2:3 rectangle that *fits* is right for either orientation:
 * width is capped by the frame, height by what that width can support.
 *
 *   1920×1080 → min(1920, 720) × min(1080, 2880) = 720×1080
 *   1080×1920 → min(1080, 1280) × min(1920, 1620) = 1080×1620
 *
 * `crop` centres by default, which is the centre half of "centre crop".
 *
 * The `\,` are escaped for **ffmpeg's** parser, not for a shell — nothing here
 * goes through one. A bare comma inside `min()` would end the `crop` filter and
 * start a nonexistent one.
 */
export function captureFilter(shape: ArtworkShape): string {
  return shape === 'poster'
    ? 'crop=min(iw\\,ih*2/3):min(ih\\,iw*3/2),scale=400:600'
    : 'scale=640:-2';
}
