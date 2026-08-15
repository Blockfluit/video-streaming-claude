import type { SubtitleCandidate } from '@video/shared';

/**
 * What a subtitle source has to be able to do, so the service that orchestrates
 * a search does not know which one it is talking to.
 *
 * There is one implementation today. The interface exists because the endpoints
 * and the picker are the expensive part to change later, not the HTTP calls —
 * a second source should be a new file, not a reshaped API.
 */

export interface SubtitleQuery {
  /** ISO 639-1/2. Providers index by language, so this is never optional. */
  language: string;
  /**
   * The OSDb hash of the source file, when there is one.
   *
   * Present means "find the subtitle timed against this exact release", which
   * is a different and much better question than the title one.
   */
  movieHash?: string;
  /** Free text — the library's title, or whatever the admin typed instead. */
  query?: string;
  /** `tt0133093`. Exact where a title is a guess, so it is preferred to one. */
  imdbId?: string;
  year?: number;
  seasonNumber?: number;
  episodeNumber?: number;
}

export interface DownloadedSubtitle {
  bytes: Buffer;
  /** `srt`, `vtt`, `ass`, … — decides whether the install path has to convert. */
  format: string;
}

export interface SubtitleProvider {
  /** Shown to an admin when something goes wrong, so name the service. */
  readonly name: string;

  /**
   * False when the operator has not configured credentials.
   *
   * Read rather than thrown, so the admin UI can hide a button that cannot work
   * instead of offering one that always fails.
   */
  readonly isConfigured: boolean;

  search(query: SubtitleQuery): Promise<SubtitleCandidate[]>;

  download(fileId: string): Promise<DownloadedSubtitle>;
}

/** Nest injection token — the interface is a type and cannot be one itself. */
export const SUBTITLE_PROVIDER = Symbol('SUBTITLE_PROVIDER');
