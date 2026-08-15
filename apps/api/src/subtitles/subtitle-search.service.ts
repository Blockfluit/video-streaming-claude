import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  MAX_SUBTITLE_CANDIDATES,
  toPage,
  type Page,
  type SubtitleCandidate,
} from '@video/shared';

import { languageName } from '../common/language';
import { StorageService } from '../common/storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { osdbHashOfFile } from './providers/hash';
import { SUBTITLE_PROVIDER, type SubtitleProvider, type SubtitleQuota } from './providers/provider';
import { searchTermsFor } from './providers/search-terms';
import { SubtitlesService } from './subtitles.service';

/**
 * Finding subtitles for a video that already exists, and installing the one an
 * admin picks.
 *
 * Deliberately **not** a `MediaJob`. That queue runs one job at a time and is
 * shared with transcoding, so a 20 KB download queued behind a forty-minute
 * encode would sit idle for forty minutes to do a second of work. Both
 * operations here are one network round trip, and an admin is waiting for the
 * answer — a synchronous request is the honest shape.
 *
 * Nothing runs on its own. An admin asks, sees what exists, and chooses — the
 * same rule that stops anything transcoding by itself, and here it also governs
 * what leaves the building: a title and a file hash go to a third party only
 * because somebody clicked.
 */

/** The video, and the show it belongs to, as the search needs to see it. */
const SUBJECT_SELECT = {
  id: true,
  title: true,
  year: true,
  imdbId: true,
  storageKey: true,
  sourceDeletedAt: true,
  collections: {
    take: 1,
    orderBy: { addedAt: 'asc' },
    select: {
      orderIndex: true,
      collection: { select: { title: true } },
      season: { select: { number: true } },
    },
  },
} as const;

@Injectable()
export class SubtitleSearchService {
  private readonly logger = new Logger(SubtitleSearchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly subtitles: SubtitlesService,
    @Inject(SUBTITLE_PROVIDER) private readonly provider: SubtitleProvider,
  ) {}

  get isConfigured(): boolean {
    return this.provider.isConfigured;
  }

  /**
   * Candidates for a video, best first.
   *
   * The hash is asked first and the title only if it found nothing. A hash
   * match was timed against this exact file; a title match was timed against
   * some other release of the same work and may drift by seconds, which is the
   * difference between subtitles that work and subtitles that annoy.
   */
  async search(videoId: string, input: { language: string; query?: string | null }): Promise<Page<SubtitleCandidate>> {
    this.assertConfigured();
    const video = await this.load(videoId);

    const language = input.language.trim().toLowerCase();
    const typed = input.query?.trim();

    let candidates: SubtitleCandidate[] = [];

    // An admin who typed a query is overriding the derived question; answering
    // with hash matches instead would ignore what they asked.
    if (!typed) {
      const hash = await this.hashOf(video);
      if (hash) {
        candidates = await this.provider.search({ language, movieHash: hash });
        this.logger.log(`${candidates.length} candidate(s) by hash for ${videoId}`);
      }
    }

    if (candidates.length === 0) {
      const terms = searchTermsFor(
        {
          title: video.title,
          year: video.year,
          imdbId: video.imdbId,
          collectionTitle: video.collections[0]?.collection.title ?? null,
          seasonNumber: video.collections[0]?.season?.number ?? null,
          // `orderIndex` is the episode's place in its season, which is the
          // episode number whenever ingest could read one off the filename.
          // Where it could not, it is null and the search asks for the season.
          episodeNumber: video.collections[0]?.orderIndex ?? null,
        },
        typed,
      );
      candidates = await this.provider.search({ language, ...terms });
    }

    return toPage(candidates, candidates.length, { limit: MAX_SUBTITLE_CANDIDATES, offset: 0 });
  }

  /**
   * What is left of today's download allowance.
   *
   * Its own call rather than a field on the search response: the picker wants
   * this the moment it opens, before anyone has searched for anything, and a
   * search that also reported a quota would have to make this call whether or
   * not the screen asking for it was interested.
   */
  quota(): Promise<SubtitleQuota | null> {
    this.assertConfigured();
    return this.provider.quota();
  }

  /** Downloads the chosen candidate and installs it as a track on the video. */
  async install(
    videoId: string,
    input: { fileId: string; language: string; label?: string; isDefault?: boolean },
  ) {
    this.assertConfigured();
    await this.load(videoId);

    const language = input.language.trim().toLowerCase();
    const downloaded = await this.provider.download(input.fileId);

    return this.subtitles.installDownloaded({
      videoId,
      fileId: input.fileId,
      bytes: downloaded.bytes,
      format: downloaded.format,
      language,
      // A track with no name in the picker is worse than a generic one; the
      // language's own name is what a viewer expects to read anyway.
      label: input.label?.trim() || languageName(language) || language.toUpperCase(),
      isDefault: input.isDefault ?? false,
    });
  }

  private assertConfigured(): void {
    if (this.provider.isConfigured) return;

    throw new ServiceUnavailableException(
      `Subtitle search is not configured on this server. Set OPENSUBTITLES_API_KEY to enable it.`,
    );
  }

  private async load(videoId: string) {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      select: SUBJECT_SELECT,
    });
    if (!video) throw new NotFoundException('No such video');

    return video;
  }

  /**
   * The hash of the **source**, never the converted MP4.
   *
   * A transcode is not a release anyone else has, so its hash matches nothing
   * in any provider's index — hashing it would silently turn the good half of
   * this feature off. A reclaimed source simply has no hash, and the title
   * search covers it.
   */
  private async hashOf(video: { storageKey: string; sourceDeletedAt: Date | null }): Promise<string | null> {
    if (video.sourceDeletedAt) return null;

    try {
      return await osdbHashOfFile(this.storage.resolvePath('media', video.storageKey));
    } catch {
      // A bad key or an unreadable file is a reason to search by title, not to
      // fail a search the admin can still get an answer from.
      return null;
    }
  }
}
