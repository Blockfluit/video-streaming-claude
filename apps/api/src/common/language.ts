import langs from 'langs';

/**
 * ISO 639 lookups, in one place because more than the subtitle matcher needs
 * them: serving `<track srclang>` (step 11), naming extracted subtitle streams
 * (step 12) and validating manual subtitle uploads all ask the same questions.
 *
 * Backed by `langs` rather than a hand-written table. The list is a frozen
 * standard, so "last published in 2022" is a property of the data, not neglect
 * — and getting the 639-2 duality right by hand is exactly the sort of detail
 * that goes quietly wrong.
 */

/**
 * Every code form a media file might use.
 *
 * A language can have two three-letter codes: a bibliographic one derived from
 * the English name and a terminological one from the native name — Dutch is
 * `dut` and `nld`, German is `ger` and `deu`. Files in the wild use both.
 */
const CODE_SETS = ['1', '2', '2B', '2T', '3'] as const;

function lookup(code: string): langs.Language | undefined {
  const normalised = code.trim().toLowerCase();
  if (normalised.length === 0) return undefined;

  for (const set of CODE_SETS) {
    const found = langs.where(set, normalised);
    if (found) return found;
  }

  return undefined;
}

/**
 * True for a code in ISO 639-1, -2 (either form) or -3.
 *
 * Callers treat `false` as "worth flagging", never as "reject": a subtitle with
 * an unrecognised code still plays, and refusing it would be a worse failure
 * than an advisory in the admin's issue list.
 */
export function isKnownLanguage(code: string): boolean {
  return lookup(code) !== undefined;
}

/** The English name for a code, or null if it is not recognised. */
export function languageName(code: string): string | null {
  return lookup(code)?.name ?? null;
}

/** The language's own name for itself — what a viewer picking a track would rather read. */
export function languageNativeName(code: string): string | null {
  return lookup(code)?.local ?? null;
}
