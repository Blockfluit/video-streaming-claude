import type { CreditRole } from '../prisma/generated/enums';
import { mergeCredits, type MergeableCredit } from './merge';

let next = 0;

const credit = (
  name: string,
  role: CreditRole,
  overrides: Partial<MergeableCredit> = {},
): MergeableCredit => {
  next += 1;
  return {
    id: `c${next}`,
    personId: `p-${name}`,
    role,
    characterName: null,
    position: 0,
    jobTitle: null,
    department: null,
    person: {
      id: `p-${name}`,
      slug: name.toLowerCase(),
      name,
      photoKey: null,
      imdbId: null,
      knownFor: null,
    },
    ...overrides,
  };
};

const names = (credits: { person: { name: string } }[]): string[] =>
  credits.map((entry) => entry.person.name);

describe('mergeCredits', () => {
  it('returns nothing when neither parent has credits', () => {
    expect(mergeCredits([], [])).toEqual([]);
  });

  it('returns a video’s own credits when its collection has none', () => {
    expect(names(mergeCredits([], [credit('Ada', 'ACTOR')]))).toEqual(['Ada']);
  });

  /**
   * The reason the merge exists: a series' main cast is entered once on the
   * collection, and an episode only carries its guest stars.
   */
  it('shows a series’ cast on an episode that has none of its own', () => {
    const merged = mergeCredits([credit('Ada', 'ACTOR')], []);

    expect(names(merged)).toEqual(['Ada']);
    expect(merged[0].inherited).toBe(true);
  });

  it('marks where each credit was entered, since that is where it is edited', () => {
    const merged = mergeCredits([credit('Ada', 'ACTOR')], [credit('Grace', 'ACTOR')]);

    expect(merged.map((entry) => [entry.person.name, entry.inherited])).toEqual([
      ['Ada', true],
      ['Grace', false],
    ]);
  });

  describe('the same person credited on both', () => {
    /**
     * The episode's credit is the more specific one and can carry an
     * episode-specific character name, so it wins outright rather than
     * appearing twice.
     */
    it('keeps the episode’s credit, not the series’', () => {
      const merged = mergeCredits(
        [credit('Ada', 'ACTOR', { characterName: 'The Countess' })],
        [credit('Ada', 'ACTOR', { characterName: 'The Countess, older' })],
      );

      expect(merged).toHaveLength(1);
      expect(merged[0]).toMatchObject({
        characterName: 'The Countess, older',
        inherited: false,
      });
    });

    // Same person, different jobs, is two credits — not a duplicate.
    it('keeps both when the roles differ', () => {
      const merged = mergeCredits([credit('Ada', 'ACTOR')], [credit('Ada', 'DIRECTOR')]);

      expect(merged).toHaveLength(2);
    });

    // An import stores every crew member, and all but six jobs become OTHER. So
    // one person doing two different jobs is the ordinary case rather than the
    // exotic one, and on `personId:role` alone they collide with themselves —
    // the series' credit vanishes from the episode that has the other.
    it('keeps both OTHER credits when the same person did two different jobs', () => {
      const merged = mergeCredits(
        [credit('Ada', 'OTHER', { jobTitle: 'Costume Designer' })],
        [credit('Ada', 'OTHER', { jobTitle: 'Stunt Coordinator' })],
      );

      expect(merged).toHaveLength(2);
      expect(merged.map((entry) => entry.jobTitle)).toEqual([
        'Costume Designer',
        'Stunt Coordinator',
      ]);
    });

    it('still lets an episode replace the series’ credit for the same job', () => {
      const merged = mergeCredits(
        [credit('Ada', 'OTHER', { jobTitle: 'Costume Designer' })],
        [credit('Ada', 'OTHER', { jobTitle: 'Costume Designer' })],
      );

      expect(merged).toHaveLength(1);
      expect(merged[0]!.inherited).toBe(false);
    });
  });

  describe('order', () => {
    // The enum's own declaration order, so the two cannot drift apart.
    it('groups by role, cast first', () => {
      const merged = mergeCredits(
        [],
        [credit('Ed', 'EDITOR'), credit('Dee', 'DIRECTOR'), credit('Ada', 'ACTOR')],
      );

      expect(names(merged)).toEqual(['Ada', 'Dee', 'Ed']);
    });

    it('sorts by billing position within a role', () => {
      const merged = mergeCredits(
        [],
        [
          credit('Third', 'ACTOR', { position: 2 }),
          credit('First', 'ACTOR', { position: 0 }),
          credit('Second', 'ACTOR', { position: 1 }),
        ],
      );

      expect(names(merged)).toEqual(['First', 'Second', 'Third']);
    });

    /**
     * The two parents have independent position numbering, so a tie is normal
     * rather than exceptional. Main cast before guest stars is the convention.
     */
    it('puts the series’ cast before the episode’s when positions tie', () => {
      const merged = mergeCredits(
        [credit('Regular', 'ACTOR', { position: 0 })],
        [credit('Guest', 'ACTOR', { position: 0 })],
      );

      expect(names(merged)).toEqual(['Regular', 'Guest']);
    });

    // Without a total order the panel reshuffles between requests.
    it('breaks a remaining tie by name, so the order is stable', () => {
      const merged = mergeCredits(
        [],
        [credit('Zoe', 'ACTOR'), credit('Ada', 'ACTOR'), credit('Mo', 'ACTOR')],
      );

      expect(names(merged)).toEqual(['Ada', 'Mo', 'Zoe']);
    });
  });
});
