import { visibleStates } from '../common/publishing';

import {
  PERSON_INDEX_SETTINGS,
  TITLE_INDEX_SETTINGS,
  toPersonDocument,
  toTitleDocument,
  type TitleRow,
} from './documents';
import { stateFilter } from './filters';

const row = (extra: Partial<TitleRow> = {}): TitleRow => ({
  id: 'v1',
  title: 'Harry Potter',
  description: 'A boy goes to school.',
  genres: ['Fantasy'],
  state: 'PUBLISHED',
  ...extra,
});

describe('toTitleDocument', () => {
  it("carries the row's own text and nothing else", () => {
    expect(toTitleDocument(row(), true)).toEqual({
      id: 'v1',
      title: 'Harry Potter',
      description: 'A boy goes to school.',
      genres: ['Fantasy'],
      state: 'PUBLISHED',
      isFilm: true,
    });
  });

  /**
   * The leak invariant, checkable with no server and no database.
   *
   * A document that carried the titles of the videos standing on a shelf would
   * make "this shelf matched" a decision the engine takes with no idea of the
   * member's publish state — and the shelf's own state passes every filter
   * downstream, so Prisma would re-read it, find it published, and show it. That
   * is the one leak the re-read cannot catch, which is why it is pinned here as
   * a property of the *shape* rather than left to a database test to notice.
   */
  it('never carries text belonging to another row', () => {
    const document = toTitleDocument(row(), false);
    const text = JSON.stringify(document);

    expect(text).not.toContain('Prisoner of Azkaban');
    expect(text).not.toContain('Alan Rickman');
    // And structurally: every value is the row's own or a flag about it.
    expect(Object.keys(document).sort()).toEqual([
      'description',
      'genres',
      'id',
      'isFilm',
      'state',
      'title',
    ]);
  });

  it('keeps a missing synopsis as text rather than as null', () => {
    // The document's shape must not depend on the data, or an index ends up with
    // fields on some documents and not others and the mismatch surfaces much
    // later as settings that will not apply.
    expect(toTitleDocument(row({ description: null }), true).description).toBe('');
  });

  it('records a draft as a draft, so the filter has something to read', () => {
    expect(toTitleDocument(row({ state: 'DRAFT' }), true).state).toBe('DRAFT');
  });
});

describe('toPersonDocument', () => {
  it('carries a name and an id, and no filmography', () => {
    const document = toPersonDocument({ id: 'p1', name: 'Alan Rickman' });

    expect(document).toEqual({ id: 'p1', name: 'Alan Rickman' });
    // The join from a person to what they are credited on stays in Prisma, so a
    // rename is one document rather than a fan-out across the library.
    expect(JSON.stringify(document)).not.toContain('Die Hard');
  });
});

describe('index settings', () => {
  it('ranks a title above a genre above a synopsis', () => {
    // Meilisearch's `attribute` rule reads this order, so it is the ranking —
    // mirroring `WEIGHTS.description` being additive and small.
    expect(TITLE_INDEX_SETTINGS.searchableAttributes).toEqual(['title', 'genres', 'description']);
  });

  it('never fuzzes a synopsis', () => {
    // `scoreProse`'s rule, in the engine's language: long prose is where edit
    // distance finds a near-match for almost anything.
    expect(TITLE_INDEX_SETTINGS.typoTolerance.disableOnAttributes).toContain('description');
  });

  it('is at least as forgiving of typos as the scorer is', () => {
    /*
     * `relevance.ts` allows one edit from four characters and two from seven. An
     * engine stricter than that declines to offer rows the scorer would have
     * credited, and a row never offered is a row never scored — so this is the
     * direction that matters. More forgiving is free: anything the scorer will
     * not vouch for is dropped by `pool.filter(score > 0)`.
     */
    expect(TITLE_INDEX_SETTINGS.typoTolerance.minWordSizeForTypos.oneTypo).toBeLessThanOrEqual(4);
    expect(TITLE_INDEX_SETTINGS.typoTolerance.minWordSizeForTypos.twoTypos).toBeLessThanOrEqual(7);
  });

  it('removes no stop words', () => {
    // Two chances to make a title unfindable, and a contradiction of
    // `normaliseTitle`'s documented refusal to drop leading articles.
    expect(TITLE_INDEX_SETTINGS.stopWords).toEqual([]);
    expect(PERSON_INDEX_SETTINGS.stopWords).toEqual([]);
  });

  it('declares every attribute the filter reads', () => {
    // A filter naming an undeclared attribute is a 400 with zero hits, which is
    // indistinguishable from "nothing matched" unless something notices.
    expect(TITLE_INDEX_SETTINGS.filterableAttributes).toContain('state');
  });
});

describe('stateFilter', () => {
  it('offers a viewer only what is published', () => {
    expect(stateFilter('USER')).toBe('state IN [PUBLISHED]');
  });

  it('renders whatever the one definition says, for either role', () => {
    // Asserted against the helper rather than against a list written here: this
    // is a rendering of `visibleStates`, and a second copy of the states is the
    // failure it exists to avoid.
    for (const role of ['ADMIN', 'USER'] as const) {
      expect(stateFilter(role)).toBe(`state IN [${visibleStates(role).join(', ')}]`);
    }
  });

  it("never lets a draft into a viewer's budget", () => {
    expect(stateFilter('USER')).not.toContain('DRAFT');
  });
});
