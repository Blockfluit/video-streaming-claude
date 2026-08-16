import { toIso6391 } from '../common/language';

/**
 * Choosing which subtitle track carries `default`, when nobody has chosen by hand.
 *
 * Pure, and separated from the service, because it is a rule rather than a
 * database operation: the interesting cases (no English at all, two English
 * tracks, a track already holding the default) are all decidable from the list
 * alone, and every one of them is a bug that would otherwise only show up as a
 * viewer seeing the wrong language.
 */
export interface DefaultCandidate {
  id: string;
  /** Whatever form the file used — `en`, `eng`, `und`. Compared through ISO 639. */
  language: string;
  label: string;
  isDefault: boolean;
}

/**
 * The track that should carry `default`, or null for none.
 *
 * **English only.** A video whose subtitles are all Dutch gets no default
 * rather than an arbitrary one: `<track default>` on a language the viewer
 * cannot read is worse than none, because it turns subtitles on and leaves
 * them to find the menu that turns them off again. Nothing is a legitimate
 * answer here, which is why the return type admits it.
 */
export function pickDefaultTrack(tracks: DefaultCandidate[]): string | null {
  const english = tracks.filter((track) => toIso6391(track.language) === 'en');

  if (english.length === 0) return null;

  // Already settled. A rescan that reshuffles the default reads as a rendering
  // bug long before anyone suspects this function.
  const current = english.find((track) => track.isDefault);
  if (current) return current.id;

  /**
   * A **total** order, ending on the id.
   *
   * Two English tracks with the same label are normal — an extracted one and a
   * sidecar for the same language collide constantly — so ordering on the
   * label alone leaves the answer to whatever order the rows came back in, and
   * the default then moves on its own between passes.
   */
  const [first] = [...english].sort(
    (left, right) => compare(left.label, right.label) || compare(left.id, right.id),
  );

  return first.id;
}

function compare(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
