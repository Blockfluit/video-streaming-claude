import type { SearchMetadataQuery, TmdbType } from '@video/shared';

import { MetadataService } from './metadata.service';
import type { TmdbClient } from './tmdb.client';
import type { TmdbSearchResponse } from './tmdb.types';
import type { CollectionArtworkService, MediaService } from '../media/media.service';
import type { PeopleService } from '../people/people.service';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Unit coverage for `search()`'s pagination loop. `metadata.db-spec.ts` proves
 * the HTTP-level behaviour against a real database; this pins the thing that
 * is invisible from outside — exactly how many TMDB pages get asked for, and
 * in what order.
 */
describe('MetadataService.search', () => {
  let searchTitles: jest.Mock;
  let service: MetadataService;

  const query = (overrides: Partial<SearchMetadataQuery> = {}): SearchMetadataQuery =>
    ({ title: 'Arrival', limit: 20, offset: 0, ...overrides }) as SearchMetadataQuery;

  /** One full page's worth of raw, distinct, well-formed TMDB search results. */
  const page = (start: number, count: number): TmdbSearchResponse => ({
    results: Array.from({ length: count }, (_, index) => ({
      id: start + index,
      title: `Title ${start + index}`,
      media_type: 'movie' as const,
      release_date: '2020-01-01',
    })),
  });

  beforeEach(() => {
    searchTitles = jest.fn();
    service = new MetadataService(
      {} as unknown as PrismaService,
      { searchTitles } as unknown as TmdbClient,
      {} as unknown as PeopleService,
      {} as unknown as MediaService,
      {} as unknown as CollectionArtworkService,
    );
  });

  it('fetches only one page when it is shorter than TMDB\'s own page size', async () => {
    searchTitles.mockResolvedValueOnce(page(1, 5));

    const result = await service.search(query());

    expect(searchTitles).toHaveBeenCalledTimes(1);
    expect(result.total).toBe(5);
    expect(result.hasMore).toBe(false);
  });

  it('fetches a second page as look-ahead when the first page might not be the last', async () => {
    searchTitles.mockResolvedValueOnce(page(1, 20)).mockResolvedValueOnce(page(21, 5));

    const result = await service.search(query({ limit: 20, offset: 0 }));

    expect(searchTitles).toHaveBeenCalledTimes(2);
    expect(result.items).toHaveLength(20);
    expect(result.total).toBe(25);
    expect(result.hasMore).toBe(true);
  });

  it('stops with fewer pages once TMDB itself runs out, without waiting for the cap', async () => {
    searchTitles.mockResolvedValueOnce(page(1, 20)).mockResolvedValueOnce(page(21, 10));

    await service.search(query({ limit: 20, offset: 20 }));

    expect(searchTitles).toHaveBeenCalledTimes(2);
  });

  it('never asks TMDB for more than three pages, however large the window', async () => {
    searchTitles.mockResolvedValue(page(1, 20));

    const result = await service.search(query({ limit: 100, offset: 0 }));

    expect(searchTitles).toHaveBeenCalledTimes(3);
    expect(result.total).toBe(60);
    // Degrades gracefully rather than claiming more exists once the cap is hit.
    expect(result.hasMore).toBe(false);
  });

  it('computes total from mapped candidates, not raw TMDB counts', async () => {
    searchTitles
      .mockResolvedValueOnce({
        results: [
          ...page(1, 18).results!,
          { id: 900, name: 'Some Person', media_type: 'person' },
          { id: 901, media_type: 'movie' }, // no title — also dropped
        ],
      })
      .mockResolvedValueOnce(page(21, 0));

    const result = await service.search(query({ limit: 20, offset: 0 }));

    // 20 raw results (a full page, so the loop looks ahead) but only 18 mapped.
    expect(searchTitles).toHaveBeenCalledTimes(2);
    expect(result.total).toBe(18);
  });

  it('passes the requested page number through to TmdbClient.searchTitles, in order', async () => {
    searchTitles.mockResolvedValue(page(1, 20));

    await service.search(query({ limit: 100, offset: 0 }));

    expect(searchTitles.mock.calls.map((call) => call[3])).toEqual([1, 2, 3]);
  });

  it('passes the title, type and year through unchanged', async () => {
    searchTitles.mockResolvedValueOnce(page(1, 1));

    await service.search(query({ title: 'Arrival', type: 'movie' as TmdbType, year: 2016 }));

    expect(searchTitles).toHaveBeenCalledWith('Arrival', 'movie', 2016, 1);
  });
});
