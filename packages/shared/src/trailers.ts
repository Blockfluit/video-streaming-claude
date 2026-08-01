/**
 * YouTube trailers.
 *
 * A video and a collection may each name one, and a video with none inherits
 * its collection's — set a show's trailer once and every episode's overview
 * page gets it. Only the **id** is ever stored: a URL carries tracking
 * parameters, a playlist, a start offset and a host that may change, none of
 * which belong in a database column that means "which video".
 *
 * The parsing lives here rather than in either app because both need it. The
 * API validates what an admin submits, and the admin form parses what they
 * pasted so it can show a preview before saving. Two implementations of "is
 * this a YouTube link" would disagree eventually, and the one that lost would
 * be the one that only fails on a viewer's screen.
 */

/**
 * A YouTube video id: eleven characters of base64url.
 *
 * Anchored deliberately. Unanchored, this matches any longer string with
 * something id-shaped inside it, so `https://evil.example/dQw4w9WgXcQ` would
 * pass and the embed would fail silently later.
 */
export const YOUTUBE_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

/**
 * The privacy-preserving embed host.
 *
 * `youtube-nocookie.com` does not set its tracking cookies until playback
 * starts, which matters when a trailer autoplays on a page nobody asked it to.
 * It is also the origin `postMessage` must target to control the player.
 */
export const YOUTUBE_EMBED_ORIGIN = 'https://www.youtube-nocookie.com';

/** Hosts that can legitimately name a video. Compared exactly, never by suffix. */
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

const SHORT_HOSTS = new Set(['youtu.be', 'www.youtu.be']);

/** Path prefixes that carry the id as the next segment. */
const ID_BEARING_PREFIXES = ['embed', 'shorts', 'live', 'v'];

/**
 * A bare id, or any YouTube URL that names one. Null when it names none.
 *
 * Accepts what someone actually pastes: the address bar, the Share button, the
 * embed snippet, with or without a protocol. Rejects everything else rather
 * than guessing — an unparseable string stored as a trailer id becomes an empty
 * black rectangle on the overview page, and nobody would connect the two.
 */
export function parseYoutubeId(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  if (YOUTUBE_ID_PATTERN.test(trimmed)) return trimmed;

  const url = parseUrl(trimmed);
  if (url === null) return null;

  const host = url.hostname.toLowerCase();

  if (SHORT_HOSTS.has(host)) {
    // youtu.be/<id> — the path is the id and nothing else.
    return validId(firstSegment(url.pathname));
  }

  if (!YOUTUBE_HOSTS.has(host)) return null;

  const segments = url.pathname.split('/').filter(Boolean);

  if (segments.length >= 2 && ID_BEARING_PREFIXES.includes(segments[0]!.toLowerCase())) {
    return validId(segments[1]);
  }

  // The ordinary watch URL. `v` may appear anywhere among the parameters.
  return validId(url.searchParams.get('v'));
}

/**
 * How the trailer is embedded.
 *
 * Defaults describe a background hero: muted, looping, no chrome. Anything
 * wanting a real player passes its own.
 */
export interface YoutubeEmbedOptions {
  autoplay?: boolean;
  mute?: boolean;
  loop?: boolean;
  controls?: boolean;
  /**
   * Enables the postMessage API, so the player can be unmuted in place.
   *
   * Ignored without an `origin` — YouTube refuses the pair otherwise, and the
   * origin can only be read in a browser.
   */
  jsApi?: boolean;
  origin?: string;
  startSec?: number;
}

/**
 * Builds the `<iframe src>`.
 *
 * Throws on an id that would not have parsed. The alternative is a URL that
 * loads a YouTube error page inside the hero, which looks like a styling
 * problem rather than a data one.
 */
export function youtubeEmbedUrl(id: string, options: YoutubeEmbedOptions = {}): string {
  if (!YOUTUBE_ID_PATTERN.test(id)) {
    throw new Error(`Not a YouTube video id: ${id}`);
  }

  const {
    autoplay = false,
    mute = true,
    loop = false,
    controls = true,
    jsApi = false,
    origin,
    startSec,
  } = options;

  const url = new URL(`${YOUTUBE_EMBED_ORIGIN}/embed/${id}`);
  const set = (key: string, value: string) => url.searchParams.set(key, value);

  set('autoplay', autoplay ? '1' : '0');
  set('mute', mute ? '1' : '0');
  set('controls', controls ? '1' : '0');
  set('playsinline', '1');
  // No related videos from other channels, and no annotations over the picture.
  set('rel', '0');
  set('iv_load_policy', '3');
  set('modestbranding', '1');

  if (loop) {
    set('loop', '1');
    // `loop` on a single video does nothing unless `playlist` names that same
    // video. Without this the trailer plays once and stops, which reads as a
    // bug rather than as a missing parameter.
    set('playlist', id);
  }

  if (jsApi && origin) {
    set('enablejsapi', '1');
    set('origin', origin);
  }

  if (startSec !== undefined && startSec > 0) {
    set('start', String(Math.floor(startSec)));
  }

  return url.toString();
}

/**
 * The trailer a video should show: its own, else its collection's.
 *
 * A blank string counts as absent. A cleared field arrives as `null` from the
 * API and as `''` from a form that has not been submitted yet, and the caller
 * should not have to know which it is holding.
 */
export function trailerYoutubeIdFor(
  video: { trailerYoutubeId?: string | null } | null | undefined,
  collection?: { trailerYoutubeId?: string | null } | null,
): string | null {
  return present(video?.trailerYoutubeId) ?? present(collection?.trailerYoutubeId) ?? null;
}

function present(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function validId(candidate: string | null | undefined): string | null {
  if (typeof candidate !== 'string') return null;
  return YOUTUBE_ID_PATTERN.test(candidate) ? candidate : null;
}

function firstSegment(pathname: string): string | null {
  return pathname.split('/').filter(Boolean)[0] ?? null;
}

/**
 * Parses a URL that may have arrived without a protocol.
 *
 * `new URL` refuses `www.youtube.com/watch?v=…`, which is exactly what someone
 * copying from the address bar of some browsers ends up with. Prefixing a
 * scheme is safe because the host is checked against an allow-list afterwards.
 */
function parseUrl(input: string): URL | null {
  const candidates = /^[a-z][a-z0-9+.-]*:\/\//i.test(input)
    ? [input]
    : input.startsWith('//')
      ? [`https:${input}`]
      : [`https://${input}`];

  for (const candidate of candidates) {
    try {
      return new URL(candidate);
    } catch {
      // Fall through — an unparseable string is simply not a trailer link.
    }
  }

  return null;
}
