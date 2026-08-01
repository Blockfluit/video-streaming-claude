import { YOUTUBE_ID_PATTERN } from '@video/shared';

/**
 * Turning Google's JSON into ours, and keeping the key out of everything else.
 *
 * Pure, and tested on its own, because the two things that can go wrong here
 * are both invisible at runtime: a response shape that quietly yields nothing,
 * and an API key leaking into a log line.
 */

export interface TrailerSearchResult {
  youtubeId: string;
  title: string;
  channelTitle: string | null;
  description: string | null;
  publishedAt: string | null;
  thumbnailUrl: string | null;
}

/**
 * Maps a `search.list` response, dropping anything unusable.
 *
 * Deliberately tolerant. A search that returns nine good results and one odd
 * one should show nine, not fail — the admin is picking a trailer, not
 * auditing Google's schema. Anything without a usable video id is dropped,
 * because a card that cannot be selected is worse than no card.
 */
export function mapYoutubeSearchResponse(payload: unknown): TrailerSearchResult[] {
  const items = (payload as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];

  return items.flatMap((item) => {
    const row = item as {
      id?: { kind?: string; videoId?: string };
      snippet?: {
        title?: string;
        channelTitle?: string;
        description?: string;
        publishedAt?: string;
        thumbnails?: Record<string, { url?: string } | undefined>;
      };
    };

    const youtubeId = row?.id?.videoId;
    // `type=video` is requested, but a channel or playlist coming back anyway
    // would have no video to embed.
    if (typeof youtubeId !== 'string' || !YOUTUBE_ID_PATTERN.test(youtubeId)) return [];

    const snippet = row.snippet ?? {};
    const thumbnails = snippet.thumbnails ?? {};

    return [
      {
        youtubeId,
        // A result with no title is still selectable; naming it by its id beats
        // rendering an empty card.
        title: text(snippet.title) ?? youtubeId,
        channelTitle: text(snippet.channelTitle),
        description: text(snippet.description),
        publishedAt: text(snippet.publishedAt),
        thumbnailUrl:
          text(thumbnails['medium']?.url) ??
          text(thumbnails['high']?.url) ??
          text(thumbnails['default']?.url),
      },
    ];
  });
}

/**
 * Removes the API key from anything about to be logged or returned.
 *
 * The key travels as a **query parameter**, so the request URL *is* the
 * credential — and `fetch` puts the whole URL into the message of the error it
 * throws. Every log line and every message goes through here, and Google's
 * response body is never forwarded at all.
 */
export function redactKey(text: string, key: string | undefined): string {
  if (!key) return text;

  return text.split(key).join('[redacted]');
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
