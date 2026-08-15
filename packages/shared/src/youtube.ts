/**
 * Reading a YouTube video id out of whatever someone pasted.
 *
 * Admins paste the thing in their address bar, not an id — a watch URL with a
 * playlist and a timestamp hanging off it, a `youtu.be` share link, sometimes
 * the embed URL out of an "copy embed code". Storing whichever of those arrived
 * and interpolating it into an iframe `src` produces a player that silently
 * shows nothing, and the reason is invisible in the admin form.
 *
 * So the **id** is what is stored, and it is extracted here. That also keeps the
 * embed URL ours to choose: privacy mode, autoplay, mute and the rest are
 * decided at render time rather than frozen into whatever was pasted.
 *
 * Pure and in `shared` because the form and the endpoint must agree about what
 * is acceptable — a field the browser accepts and the API rejects is the drift
 * this package exists to prevent.
 */

/**
 * YouTube ids are 11 characters of the URL-safe base64 alphabet.
 *
 * Anchored, because the point is to reject things that merely *contain*
 * something id-shaped. A playlist id is 34 characters and starts `PL`; without
 * the anchors a `list=` parameter is a perfectly good match.
 */
const ID = /^[A-Za-z0-9_-]{11}$/;

/** The paths that carry the id as their last segment rather than as a query. */
const PATH_PREFIXES = ['/embed/', '/shorts/', '/v/', '/live/'];

/**
 * Returns the 11-character id, or null if there is not one in there.
 *
 * Deliberately strict. Guessing at a malformed URL gets an id that is wrong
 * rather than absent, and a trailer that plays the wrong video is worse than one
 * that refuses to be saved.
 */
export function parseYoutubeId(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;

  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  // Already an id. Checked first so a bare id never goes near the URL parser,
  // which would read it as a relative path.
  if (ID.test(trimmed)) return trimmed;

  let url: URL;
  try {
    // Tolerate a pasted `youtu.be/xyz` with no scheme, which is what a browser
    // shows and therefore what gets copied.
    url = new URL(/^[a-z]+:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./i, '').toLowerCase();

  // `youtu.be/<id>` — the whole path is the id.
  if (host === 'youtu.be') {
    return idOrNull(url.pathname.slice(1).split('/')[0]);
  }

  if (host !== 'youtube.com' && host !== 'm.youtube.com' && host !== 'youtube-nocookie.com') {
    return null;
  }

  // The watch URL, where the id is `v` and everything else is noise: `list`,
  // `t`, `si`, whatever the share sheet appended.
  const v = url.searchParams.get('v');
  if (v) return idOrNull(v);

  for (const prefix of PATH_PREFIXES) {
    if (url.pathname.startsWith(prefix)) {
      return idOrNull(url.pathname.slice(prefix.length).split('/')[0]);
    }
  }

  return null;
}

function idOrNull(candidate: string | undefined): string | null {
  return candidate && ID.test(candidate) ? candidate : null;
}

/**
 * The URL to embed.
 *
 * `youtube-nocookie.com` because this is a private library and a hero that
 * quietly hands every viewer to Google's ad cookies is not something anyone
 * asked for. The player is decoration over a page that already has its own
 * controls, so YouTube's own chrome is off.
 *
 * `mute=1` is not a preference. Browsers refuse to start an unmuted video that
 * nobody asked for, and the failure is silent — the iframe simply sits there —
 * so the sound toggle has to be ours and start from muted.
 *
 * `controls` separates the two players this app has. The hero's trailer is
 * decoration behind a page's own heading and buttons, so YouTube's chrome is off
 * and so is `showinfo` — both would draw over the title. The trailer dialog is
 * the opposite: nothing is layered over it, somebody opened it deliberately, and
 * a video player without a scrubber is a worse player.
 */
export function youtubeEmbedUrl(
  id: string,
  options: {
    muted?: boolean;
    autoplay?: boolean;
    controls?: boolean;
    /**
     * The embedding page's own origin. YouTube documents this as required
     * alongside `enablejsapi`, and the player is entitled to ignore the
     * `postMessage` handshake without it — which here means a hero that waits
     * for a confirmation that never arrives and stays on its banner forever.
     *
     * Passed in rather than read here: this file is shared with the API, where
     * there is no `window` to read it from.
     */
    origin?: string;
  } = {},
): string {
  const { muted = true, autoplay = true, controls = false, origin } = options;

  const params = new URLSearchParams({
    autoplay: autoplay ? '1' : '0',
    mute: muted ? '1' : '0',
    controls: controls ? '1' : '0',
    modestbranding: '1',
    rel: '0',
    playsinline: '1',
    // Lets the page hear `onStateChange`, which is how the hero knows whether
    // the trailer actually started — and therefore whether to reveal it at all
    // or leave the banner where it is.
    enablejsapi: '1',
  });

  // Suppresses the player's own title and share buttons, which would otherwise
  // sit on top of the hero's text. Meaningless — and unwanted — in the dialog,
  // where the player is the content rather than a layer under it.
  if (!controls) params.set('showinfo', '0');
  if (origin) params.set('origin', origin);

  return `https://www.youtube-nocookie.com/embed/${id}?${params.toString()}`;
}
