import type { CreditRole } from '../../prisma/generated/enums';

import {
  buildTasteProfile,
  evidenceWeight,
  hasEnoughSignal,
  hasFeatures,
  MIN_STRONG_SIGNALS,
  scoreCandidate,
  WEIGHT_COMPLETED,
  WEIGHT_WATCHLISTED,
  type CandidateFeatures,
  type EngagementEvidence,
} from './taste-profile';

const credit = (
  personId: string,
  role: CreditRole,
  position: number,
): { personId: string; role: CreditRole; position: number } => ({ personId, role, position });

/** A watched-and-liked title, with sensible defaults overridable per test. */
const evidence = (overrides: Partial<EngagementEvidence> = {}): EngagementEvidence => ({
  target: { videoId: `v-${Math.random()}` },
  completed: false,
  onWatchlist: false,
  watchedFraction: null,
  genres: [],
  tags: [],
  credits: [],
  ...overrides,
});

describe('evidenceWeight', () => {
  it('weighs a completed watch at the ceiling', () => {
    expect(evidenceWeight({ completed: true, onWatchlist: false, watchedFraction: null })).toBe(
      WEIGHT_COMPLETED,
    );
  });

  it('weighs a watchlist add below a completed watch', () => {
    expect(evidenceWeight({ completed: false, onWatchlist: true, watchedFraction: null })).toBe(
      WEIGHT_WATCHLISTED,
    );
  });

  it('takes the max rather than the sum, so a completed watchlisted title counts once', () => {
    const weight = evidenceWeight({ completed: true, onWatchlist: true, watchedFraction: null });
    expect(weight).toBe(WEIGHT_COMPLETED);
    expect(weight).not.toBe(WEIGHT_COMPLETED + WEIGHT_WATCHLISTED);
  });

  it('contributes nothing below the partial-watch floor', () => {
    expect(
      evidenceWeight({ completed: false, onWatchlist: false, watchedFraction: 0.05 }),
    ).toBe(0);
  });

  it('scales a partial watch by how far they got, above the floor', () => {
    const at10 = evidenceWeight({ completed: false, onWatchlist: false, watchedFraction: 0.1 });
    const at50 = evidenceWeight({ completed: false, onWatchlist: false, watchedFraction: 0.5 });
    expect(at10).toBeGreaterThan(0);
    expect(at50).toBeGreaterThan(at10);
  });

  it('never lets a partial watch outweigh a watchlist add', () => {
    const partial = evidenceWeight({ completed: false, onWatchlist: false, watchedFraction: 1 });
    expect(partial).toBeLessThan(WEIGHT_WATCHLISTED);
  });
});

describe('buildTasteProfile', () => {
  it('gives a title its full weight in each of its genres, not split between them', () => {
    // A two-genre title beside a one-genre title: if the two-genre title split
    // its weight between Action/Comedy, Drama would end up weighted twice as
    // heavily. Undivided, all three genres carry the same raw weight (1) and
    // therefore normalise to the same share.
    const profile = buildTasteProfile([
      evidence({ completed: true, genres: ['Action', 'Comedy'] }),
      evidence({ completed: true, genres: ['Drama'] }),
    ]);

    expect(profile.genreWeights.get('Action')).toBeCloseTo(1 / 3);
    expect(profile.genreWeights.get('Comedy')).toBeCloseTo(1 / 3);
    expect(profile.genreWeights.get('Drama')).toBeCloseTo(1 / 3);
  });

  it('normalises each category to sum to 1 across a multi-item profile', () => {
    const profile = buildTasteProfile([
      evidence({ completed: true, genres: ['Action'] }),
      evidence({ completed: true, genres: ['Drama'] }),
    ]);

    const total = [...profile.genreWeights.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1);
    expect(profile.genreWeights.get('Action')).toBeCloseTo(0.5);
    expect(profile.genreWeights.get('Drama')).toBeCloseTo(0.5);
  });

  it('ranks a lead actor above another cast member billed much later, within one profile', () => {
    // Weights are normalised to sum to 1, so only relative standing *within*
    // a profile is meaningful — this pits two people against each other in
    // the same profile rather than comparing two single-person profiles,
    // which would trivially normalise to 1 either way.
    const profile = buildTasteProfile([
      evidence({
        completed: true,
        credits: [credit('lead', 'ACTOR', 0), credit('extra', 'ACTOR', 39)],
      }),
    ]);

    expect(profile.personWeights.get('lead')!).toBeGreaterThan(profile.personWeights.get('extra')!);
  });

  it('weighs a director credit above an OTHER credit at the same position', () => {
    const profile = buildTasteProfile([
      evidence({
        completed: true,
        credits: [credit('director', 'DIRECTOR', 0), credit('other', 'OTHER', 0)],
      }),
    ]);

    expect(profile.personWeights.get('director')!).toBeGreaterThan(
      profile.personWeights.get('other')!,
    );
  });

  it('does not double-count two evidence entries for the same target', () => {
    const target = { videoId: 'v1' };
    const profile = buildTasteProfile([
      evidence({ target, completed: true, genres: ['Action'] }),
      evidence({ target, onWatchlist: true, genres: ['Action'] }),
    ]);

    // A single title, however many evidence rows describe it, contributes once —
    // so this profile's one genre is the same as a single-evidence profile's.
    const single = buildTasteProfile([evidence({ target, completed: true, genres: ['Action'] })]);
    expect(profile.genreWeights.get('Action')).toBe(single.genreWeights.get('Action'));
  });

  it('counts a duplicated target as one strong signal, not two', () => {
    const target = { videoId: 'v1' };
    const profile = buildTasteProfile([
      evidence({ target, completed: true }),
      evidence({ target, onWatchlist: true }),
    ]);

    expect(profile.strongSignalCount).toBe(1);
  });

  it('ignores a target whose only evidence is a below-floor partial watch', () => {
    const profile = buildTasteProfile([
      evidence({ watchedFraction: 0.05, genres: ['Horror'] }),
    ]);

    expect(profile.genreWeights.size).toBe(0);
  });
});

describe('scoreCandidate', () => {
  const candidate = (overrides: Partial<CandidateFeatures> = {}): CandidateFeatures => ({
    genres: [],
    tags: [],
    credits: [],
    ...overrides,
  });

  it('scores a candidate sharing nothing with the profile at zero', () => {
    const profile = buildTasteProfile([evidence({ completed: true, genres: ['Action'] })]);
    expect(scoreCandidate(profile, candidate({ genres: ['Documentary'] }))).toBe(0);
  });

  it('scores a candidate matching every weighted genre, tag and person near the ceiling', () => {
    const profile = buildTasteProfile([
      evidence({
        completed: true,
        genres: ['Action'],
        tags: ['favourite'],
        credits: [credit('p1', 'ACTOR', 0)],
      }),
    ]);

    const score = scoreCandidate(
      profile,
      candidate({ genres: ['Action'], tags: ['favourite'], credits: [credit('p1', 'ACTOR', 0)] }),
    );

    expect(score).toBeGreaterThan(0.9);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('reads the candidate’s own billing, not just the profile’s memory of the person', () => {
    const profile = buildTasteProfile([
      evidence({ completed: true, credits: [credit('p1', 'ACTOR', 0)] }),
    ]);

    const asLead = scoreCandidate(profile, candidate({ credits: [credit('p1', 'ACTOR', 0)] }));
    const asExtra = scoreCandidate(profile, candidate({ credits: [credit('p1', 'ACTOR', 38)] }));

    expect(asLead).toBeGreaterThan(asExtra);
  });

  it('stays within [0, 1] for an empty profile', () => {
    const profile = buildTasteProfile([]);
    const score = scoreCandidate(profile, candidate({ genres: ['Action'] }));
    expect(score).toBe(0);
  });
});

describe('hasEnoughSignal', () => {
  const evidenceCount = (n: number): EngagementEvidence[] =>
    Array.from({ length: n }, (_, i) => evidence({ target: { videoId: `v${i}` }, completed: true }));

  it(`is false at ${MIN_STRONG_SIGNALS - 1} strong signals`, () => {
    expect(hasEnoughSignal(buildTasteProfile(evidenceCount(MIN_STRONG_SIGNALS - 1)))).toBe(false);
  });

  it(`is true at ${MIN_STRONG_SIGNALS} strong signals`, () => {
    expect(hasEnoughSignal(buildTasteProfile(evidenceCount(MIN_STRONG_SIGNALS)))).toBe(true);
  });

  it('never clears the gate from partial-only watches, however many there are', () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      evidence({ target: { videoId: `v${i}` }, watchedFraction: 0.8 }),
    );

    expect(hasEnoughSignal(buildTasteProfile(many))).toBe(false);
  });
});

describe('hasFeatures', () => {
  it('is false for a title with no genres, tags or credits — nothing to have scored it on', () => {
    expect(hasFeatures({ genres: [], tags: [], credits: [] })).toBe(false);
  });

  it('is true if only genres are present', () => {
    expect(hasFeatures({ genres: ['Drama'], tags: [], credits: [] })).toBe(true);
  });

  it('is true if only tags are present', () => {
    expect(hasFeatures({ genres: [], tags: ['favourite'], credits: [] })).toBe(true);
  });

  it('is true if only credits are present', () => {
    expect(
      hasFeatures({ genres: [], tags: [], credits: [credit('p1', 'ACTOR', 0)] }),
    ).toBe(true);
  });
});
