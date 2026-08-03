import {
  collectionMissingFields,
  videoMissingFields,
  visibleStates,
  whereVisible,
} from './publishing';

const publishableVideo = {
  title: 'Philosophers Stone',
  description: 'A boy discovers he is a wizard.',
  durationSec: 9152,
  bannerKey: 'derived/hp/1.jpg',
};

const publishableCollection = {
  title: 'Harry Potter',
  description: 'The films.',
  publishableVideoCount: 1,
};

describe('videoMissingFields', () => {
  it('is empty when everything the plan requires is present', () => {
    expect(videoMissingFields(publishableVideo)).toEqual([]);
  });

  it.each(['title', 'description', 'durationSec', 'bannerKey'] as const)(
    'reports a missing %s',
    (field) => {
      expect(videoMissingFields({ ...publishableVideo, [field]: null })).toEqual([field]);
    },
  );

  it('reports every missing field at once, so the checklist is complete', () => {
    expect(
      videoMissingFields({
        title: '',
        description: null,
        durationSec: null,
        bannerKey: null,
      }),
    ).toEqual(['title', 'description', 'durationSec', 'bannerKey']);
  });

  // A title of spaces passes a NOT NULL check and fails a human one.
  it('treats a blank string as missing', () => {
    expect(videoMissingFields({ ...publishableVideo, title: '   ' })).toEqual(['title']);
    expect(videoMissingFields({ ...publishableVideo, description: '' })).toEqual(['description']);
  });

  // Probing writes durationSec, and a zero-length video means the probe found
  // nothing usable.
  it('treats a zero duration as missing', () => {
    expect(videoMissingFields({ ...publishableVideo, durationSec: 0 })).toEqual(['durationSec']);
  });

  // Credits, subtitles and markers are explicitly never required.
  it('does not ask for anything the plan says is optional', () => {
    expect(videoMissingFields({ ...publishableVideo })).toEqual([]);
  });
});

describe('collectionMissingFields', () => {
  it('is empty when the collection is ready', () => {
    expect(collectionMissingFields(publishableCollection)).toEqual([]);
  });

  it.each(['title', 'description'] as const)('reports a missing %s', (field) => {
    expect(collectionMissingFields({ ...publishableCollection, [field]: null })).toEqual([field]);
  });

  /**
   * A poster used to be required here, and the rule could not be satisfied:
   * nothing generated a collection poster and no endpoint accepted one, so a
   * collection could only be published if its ingest folder happened to contain
   * an image. Every collection in the real library sat in DRAFT because of it,
   * reporting a missing field with no way to fill it.
   *
   * It is also no longer meaningful — a collection with no poster of its own
   * shows its first video's, and the video requirement below already guarantees
   * there is one. Artwork is not something a collection can lack.
   */
  it('does not demand a poster it would inherit anyway', () => {
    expect(collectionMissingFields(publishableCollection)).not.toContain('posterKey');
  });

  // A collection with nothing publishable in it is an empty shelf.
  it('requires at least one publishable video', () => {
    expect(collectionMissingFields({ ...publishableCollection, publishableVideoCount: 0 })).toEqual(
      ['videos'],
    );
  });
});

describe('visibleStates', () => {
  it('shows a USER only what is published', () => {
    expect(visibleStates('USER')).toEqual(['PUBLISHED']);
  });

  // Admins curate drafts and need to see what they are curating.
  it('shows an ADMIN everything', () => {
    expect(visibleStates('ADMIN')).toEqual(expect.arrayContaining(['DRAFT', 'PUBLISHED']));
  });

  it('never shows a USER a draft, archived or missing record', () => {
    for (const state of ['DRAFT', 'ARCHIVED', 'MISSING']) {
      expect(visibleStates('USER')).not.toContain(state);
    }
  });
});

describe('whereVisible', () => {
  it('constrains a USER query to published records', () => {
    expect(whereVisible('USER')).toEqual({ state: { in: ['PUBLISHED'] } });
  });

  it('leaves an ADMIN query unconstrained', () => {
    expect(whereVisible('ADMIN')).toEqual({});
  });

  // The helper exists so services compose it into their own filters rather
  // than each inventing the rule.
  it('produces a fragment that merges with other conditions', () => {
    expect({ collectionId: 'c1', ...whereVisible('USER') }).toEqual({
      collectionId: 'c1',
      state: { in: ['PUBLISHED'] },
    });
  });
});
