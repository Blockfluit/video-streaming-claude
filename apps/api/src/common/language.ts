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

/**
 * The two-letter (639-1) form of any recognised code, or null.
 *
 * The one comparison key for "is this the same language". An extracted track
 * carries the container's tag (`eng`) while a sidecar carries whatever the
 * filename said (`en`) — comparing those as strings makes them two languages,
 * and any rule phrased as "prefer English" then skips every embedded track.
 *
 * Null covers two different cases on purpose, because callers treat them the
 * same: a code nothing recognises, and a code that is real but has no 639-1
 * form at all (`und` for an untagged stream is the one seen in practice). An
 * empty string counts as absent rather than as an answer — some entries carry
 * one, and returning `''` would compare equal to the next entry that does.
 */
export function toIso6391(code: string): string | null {
  const twoLetter = lookup(code)?.['1'];
  return twoLetter !== undefined && twoLetter.length > 0 ? twoLetter : null;
}

export interface LanguageOption {
  /** The two-letter code, which is what `<track srclang>` and providers want. */
  code: string;
  name: string;
  nativeName: string;
}

/**
 * The languages a picker can offer, by name.
 *
 * Narrowed to ISO 639-1 — the ~185 languages with a two-letter code — because
 * that is both what subtitle providers index by and a list a person can scroll.
 * The full 639-3 set runs to thousands, nearly none of which anyone has ever
 * subtitled a film in.
 *
 * Derived from the package rather than typed out here. A hand-written list of
 * languages is wrong the moment someone needs the one that was left out.
 */
export function listLanguages(): LanguageOption[] {
  return langs
    .all()
    .filter((language) => typeof language['1'] === 'string' && language['1'].length === 2)
    .map((language) => ({ code: language['1'], name: language.name, nativeName: language.local }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
