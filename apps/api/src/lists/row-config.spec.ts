import { ROW_SOURCES, ROW_SOURCE_SPECS, unsupportedRowFields } from '@video/shared';

/**
 * Which settings a row's source actually reads.
 *
 * The rule is shared because two callers need the same answer: the create
 * schema, which is handed a source, and the service, which has to work out what
 * a PATCH leaves the row with. A form offering a field the endpoint ignores is
 * the failure this prevents.
 */
describe('unsupportedRowFields', () => {
  it('accepts a window on a trending row', () => {
    expect(unsupportedRowFields('TRENDING', { windowDays: 7 })).toEqual([]);
  });

  it('refuses a window on a row that has no window', () => {
    expect(unsupportedRowFields('MOST_VIEWED', { windowDays: 7 })).toEqual(['windowDays']);
  });

  it('refuses every computed setting on a hand-picked row', () => {
    expect(
      unsupportedRowFields('MANUAL', { kind: 'AUTO', maxItems: 5, windowDays: 7, tags: ['a'] }),
    ).toEqual(['kind', 'maxItems', 'windowDays', 'tags']);
  });

  it('refuses a tag filter on a personal row, whose contents are the viewer\'s own', () => {
    expect(unsupportedRowFields('CONTINUE_WATCHING', { tags: ['noir'] })).toEqual(['tags']);
  });

  it('allows a personal row to be capped, which is the one thing it does read', () => {
    expect(unsupportedRowFields('MY_LIST', { maxItems: 8 })).toEqual([]);
  });

  it('says nothing about settings that were not supplied', () => {
    expect(unsupportedRowFields('MANUAL', {})).toEqual([]);
  });

  it('ignores an explicit undefined, which is how an untouched form field arrives', () => {
    expect(unsupportedRowFields('MANUAL', { windowDays: undefined })).toEqual([]);
  });

  it('reports a null, which is a value someone chose rather than one they omitted', () => {
    expect(unsupportedRowFields('MANUAL', { windowDays: null })).toEqual(['windowDays']);
  });
});

describe('ROW_SOURCE_SPECS', () => {
  it('describes every source, so the admin form cannot meet one it has no label for', () => {
    for (const source of ROW_SOURCES) {
      expect(ROW_SOURCE_SPECS[source]?.label).toBeTruthy();
      expect(ROW_SOURCE_SPECS[source]?.hint).toBeTruthy();
    }
  });

  it('gives items to the hand-picked source alone', () => {
    const withItems = ROW_SOURCES.filter((source) =>
      ROW_SOURCE_SPECS[source].fields.includes('items'),
    );

    expect(withItems).toEqual(['MANUAL']);
  });

  it('gives a window to trending alone', () => {
    const windowed = ROW_SOURCES.filter((source) =>
      ROW_SOURCE_SPECS[source].fields.includes('windowDays'),
    );

    expect(windowed).toEqual(['TRENDING']);
  });
});
