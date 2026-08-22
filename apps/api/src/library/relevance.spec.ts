import { editDistance, prepareSearch, scoreEntry, scoreText, WEIGHTS } from './relevance';

/**
 * What "the best answer first" means, pinned as relationships rather than as
 * numbers.
 *
 * The weights are a tuning artefact and will move; the orderings they exist to
 * produce are the requirement. A suite full of `toBe(0.85)` goes red on every
 * pass of tuning and tells you nothing about which behaviour broke, so every
 * case here compares two scores instead of naming one.
 */

const search = prepareSearch;

/** The shape `scoreEntry` reads, with everything a plain film leaves empty. */
const entry = (title: string, extra: Partial<Parameters<typeof scoreEntry>[1]> = {}) => ({
  title,
  normalisedTitle: title
    .normalize('NFKD')
    .replace(/\p{Mn}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ''),
  ...extra,
});

const score = (q: string, title: string, extra = {}) => scoreEntry(search(q), entry(title, extra));

describe('editDistance', () => {
  it('counts a substitution, an insertion and a deletion as one each', () => {
    expect(editDistance('cat', 'cut', 2)).toBe(1);
    expect(editDistance('cat', 'cart', 2)).toBe(1);
    expect(editDistance('cart', 'cat', 2)).toBe(1);
  });

  it('counts a transposition as one, not two', () => {
    // The whole reason this is Damerau rather than plain Levenshtein: swapping
    // two letters is the commonest typing mistake there is, and charging two
    // for it puts `teh` out of reach of a tolerance of one.
    expect(editDistance('teh', 'the', 2)).toBe(1);
  });

  it('is zero for identical strings and symmetric otherwise', () => {
    expect(editDistance('matrix', 'matrix', 2)).toBe(0);
    expect(editDistance('matrix', 'matrxi', 2)).toBe(editDistance('matrxi', 'matrix', 2));
  });

  it('gives up rather than finishing, once the bound is passed', () => {
    // A caller only ever asks "is this within `max`", so computing the true
    // distance between two unrelated words is work nobody reads.
    expect(editDistance('brazil', 'interstellar', 2)).toBeGreaterThan(2);
  });

  it('short-circuits on length alone', () => {
    expect(editDistance('a', 'abcdefgh', 2)).toBeGreaterThan(2);
  });

  it('handles an empty string on either side', () => {
    expect(editDistance('', '', 2)).toBe(0);
    expect(editDistance('', 'ab', 2)).toBe(2);
  });
});

describe('prepareSearch', () => {
  it('keeps the words and the run-together form, because the tiers need both', () => {
    expect(prepareSearch('Star Wars')).toEqual({ normalised: 'starwars', tokens: ['star', 'wars'] });
  });

  it('folds accents and drops punctuation', () => {
    expect(prepareSearch('Amélie!').tokens).toEqual(['amelie']);
  });

  it('is empty for a blank query, which scores nothing rather than everything', () => {
    expect(prepareSearch('   ')).toEqual({ normalised: '', tokens: [] });
  });

  it('refuses to carry more tokens than a search has any business carrying', () => {
    // `q` is capped at 200 characters, which is a lot of one-letter words, and
    // every token costs an edit-distance pass over every word of every
    // candidate.
    const many = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');

    expect(prepareSearch(many).tokens.length).toBeLessThanOrEqual(8);
  });
});

describe('scoreEntry — the four things a search has to tolerate', () => {
  it('tolerates a misspelling', () => {
    // "intersteller" is one substitution away from the real title and shares no
    // usable substring with it, which is exactly the case `contains` could not
    // answer at all.
    expect(score('intersteller', 'Interstellar')).toBeGreaterThan(0);
    expect(score('intersteller', 'Interstellar')).toBeGreaterThan(score('intersteller', 'Brazil'));
  });

  it('tolerates a word typed only partly', () => {
    expect(score('star wa', 'Star Wars: Episode IV')).toBeGreaterThan(
      score('star wa', 'A Star Is Born'),
    );
  });

  it('tolerates the words arriving in the wrong order', () => {
    expect(score('reloaded matrix', 'The Matrix Reloaded')).toBeGreaterThan(
      score('reloaded matrix', 'The Matrix'),
    );
  });

  it('tolerates a missing accent', () => {
    expect(score('amelie', 'Amélie')).toBe(score('amelie', 'Amelie'));
    expect(score('amelie', 'Amélie')).toBeGreaterThan(score('amelie', 'Brazil'));
  });
});

describe('scoreEntry — ordering', () => {
  it('puts an exact title above one that merely starts with the query', () => {
    expect(score('matrix', 'Matrix')).toBeGreaterThan(score('matrix', 'Matrix Reloaded'));
  });

  it('puts a title that starts with the query above one that merely contains it', () => {
    expect(score('matrix', 'Matrix Reloaded')).toBeGreaterThan(score('matrix', 'The Matrix'));
  });

  it('puts a title hit above a description hit', () => {
    expect(score('space', 'Space')).toBeGreaterThan(
      score('space', 'Alien', { description: 'In space, nobody can hear you.' }),
    );
  });

  it('scores a description hit above nothing at all, or it would vanish', () => {
    // `?q=space` finding Alien by its synopsis is behaviour the catalogue suite
    // has always pinned. Ranking it last is right; dropping it is not.
    expect(score('space', 'Alien', { description: 'In space.' })).toBeGreaterThan(0);
  });

  it('lets a description break a tie but never a tier', () => {
    const withSynopsis = score('matrix', 'The Matrix', { description: 'matrix matrix matrix' });
    const exact = score('matrix', 'Matrix');

    expect(withSynopsis).toBeGreaterThan(score('matrix', 'The Matrix'));
    expect(withSynopsis).toBeLessThan(exact);
  });

  it('finds a film by a name in its cast, below a film actually called that', () => {
    const byCast = score('rickman', 'Die Hard', { castNames: ['Alan Rickman'] });

    expect(byCast).toBeGreaterThan(0);
    expect(byCast).toBeLessThan(score('rickman', 'Rickman'));
  });

  it('finds a title by its genre, which the search box has always claimed', () => {
    expect(score('horror', 'Alien', { genres: ['Horror', 'Science Fiction'] })).toBeGreaterThan(0);
  });

  it('scores nothing when nothing matches', () => {
    expect(score('zzzznothing', 'Brazil', { description: 'A bureaucrat.' })).toBe(0);
  });

  it('scores nothing for a blank query rather than everything', () => {
    expect(scoreEntry(prepareSearch(''), entry('Brazil'))).toBe(0);
  });
});

describe('scoreEntry — a shelf reached through a video on it', () => {
  it('ranks it below a shelf actually called that', () => {
    // Searching "azkaban" should answer with the shelf holding the film, but a
    // shelf genuinely named Azkaban is the better answer and must come first.
    const onShelf = scoreText(search('azkaban'), 'Prisoner of Azkaban');
    const viaVideo = score('azkaban', 'Harry Potter', { viaVideo: onShelf });

    expect(viaVideo).toBeGreaterThan(0);
    expect(viaVideo).toBeLessThan(score('azkaban', 'Azkaban'));
  });

  it('never lets a shelf outrank a film they tie with on their own titles', () => {
    /*
     * The invariant every indirect weight being a fraction exists to protect.
     *
     * A saga and one of the films on it genuinely share a name; both are right
     * answers, and `merge.ts` decides that one by putting the collection first
     * on an equal score. If a shelf could accumulate its way past the film by
     * also matching a video on it, that tie-break would stop deciding anything.
     */
    const film = score('dune', 'Dune');
    const shelf = score('dune', 'Dune', { viaVideo: scoreText(search('dune'), 'Dune') });

    expect(shelf).toBe(film);
  });
});

describe('scoreEntry — what must not be fuzzed', () => {
  it('does not fuzz a short token into a different word', () => {
    // Three letters is two typos away from most of the dictionary. `the` must
    // not find `she`, and `war` must not find `wax`.
    expect(score('the', 'She')).toBe(0);
    expect(score('war', 'Wax')).toBe(0);
  });

  it('does not fuzz a description, only its plain words', () => {
    // A synopsis is long prose, and edit distance over it produces a match for
    // almost any query — the failure mode where fuzzy search returns junk.
    expect(score('intersteller', 'Brazil', { description: 'A tale of interstellar travel.' })).toBe(
      0,
    );
  });

  it('demands every token match, not just one of them', () => {
    // "reloaded matrix" against a film called only "Matrix" is a partial answer
    // and ranks as one; against a film sharing neither word it is nothing.
    expect(score('reloaded matrix', 'Brazil')).toBe(0);
  });
});

describe('WEIGHTS', () => {
  it('keeps every indirect route below a direct one', () => {
    // Stated as a test because it is the property, not the numbers, that
    // `merge.ts`'s collection-before-film tie-break depends on.
    expect(WEIGHTS.cast).toBeLessThan(1);
    expect(WEIGHTS.genre).toBeLessThan(1);
    expect(WEIGHTS.viaVideo).toBeLessThan(1);
    expect(WEIGHTS.description).toBeLessThan(1);
  });
});
