import { Injectable } from '@nestjs/common';

import type { SearchCandidateRequest, SearchCandidates, SearchEngine } from './engine';

/**
 * No engine at all, which is what most installs run and every test tier runs.
 *
 * `isConfigured` is false, so `SearchService` never calls `candidates` and every
 * search goes through Postgres exactly as it did before any of this existed.
 * The methods throw rather than returning nothing, because a silent empty
 * answer from a path that should be unreachable is the kind of thing that gets
 * discovered as "search stopped finding anything" months later.
 *
 * This being the default is what stops the fallback rotting. The Postgres path
 * is not a branch kept alive for an outage nobody has had; it is the path the
 * whole suite and every unconfigured checkout takes on every request.
 */
@Injectable()
export class NoSearchEngine implements SearchEngine {
  readonly name = 'postgres';

  readonly isConfigured = false;

  candidates(_request: SearchCandidateRequest): Promise<SearchCandidates> {
    return Promise.reject(
      new Error('No search engine is configured; SearchService should not have asked one.'),
    );
  }
}
