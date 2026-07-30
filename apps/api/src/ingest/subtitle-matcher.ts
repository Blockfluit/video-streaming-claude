import { isKnownLanguage } from '../common/language';
import { parseOrderAndTitle } from './path-parser';

/**
 * Binds sidecar subtitle files to the videos sitting beside them.
 *
 * Pure, like the path parser, and for the same reason: the rules have more
 * corners than they look like they do, and every corner is cheap to pin down
 * here and expensive to debug once a filesystem and a database are involved.
 *
 * The convention, from docs/PLAN.md:
 *
 *   <video_name>_<lang>_<label>.<ext>
 *
 * Matching is exact-stem first, cleaned-title second. Anything ambiguous is
 * reported rather than guessed — binding the wrong language to the wrong
 * episode is worse than asking.
 */

/** `stem_lang_label`, anchored so the last two fields win — stems may contain underscores. */
const SIDECAR_PATTERN = /^(?<stem>.+)_(?<lang>[A-Za-z]{2,3})_(?<label>.+)$/;

/** Only WebVTT is servable in a `<track>`; everything else is converted in step 11. */
const SERVABLE_EXTENSION = 'vtt';

export interface ParsedSubtitleName {
  stem: string;
  /** Lowercased ISO 639-1 or 639-2 code. */
  lang: string;
  label: string;
}

export interface VideoCandidate {
  id: string;
  /** Filename without extension. */
  basename: string;
}

export interface SubtitleCandidate {
  /** Filename without extension. */
  basename: string;
  extension: string;
}

export interface SubtitleBinding {
  videoId: string;
  basename: string;
  extension: string;
  lang: string;
  label: string;
  /** False for a code outside ISO 639 — accepted, but worth an admin's attention. */
  langKnown: boolean;
  /** True for anything a browser will not accept as a `<track>` source. */
  needsConversion: boolean;
  matchedBy: 'exact-stem' | 'cleaned-title';
}

export interface UnmatchedSubtitle {
  basename: string;
  extension: string;
  reason: 'unparseable-name' | 'no-match' | 'ambiguous';
  /** Present for `ambiguous`: the videos that matched equally well. */
  candidateVideoIds?: string[];
}

export interface SubtitleMatchResult {
  bindings: SubtitleBinding[];
  unmatched: UnmatchedSubtitle[];
}

/**
 * Reads `stem_lang_label` off a filename stem.
 *
 * Greedy `stem` means the split happens at the *last* viable pair of
 * underscores, so `My_Film_Name_en_English` keeps its underscored stem.
 */
export function parseSubtitleName(basename: string): ParsedSubtitleName | null {
  const match = SIDECAR_PATTERN.exec(basename);
  if (!match?.groups) return null;

  const { stem, lang, label } = match.groups;
  if (stem.length === 0 || label.length === 0) return null;

  return { stem, lang: lang.toLowerCase(), label };
}

/** The comparable form of a name: order prefix dropped, release tags cleaned. */
function titleOf(basename: string): string {
  return parseOrderAndTitle(basename).title.toLowerCase();
}

function bindingFor(
  subtitle: SubtitleCandidate,
  parsed: ParsedSubtitleName,
  videoId: string,
  matchedBy: SubtitleBinding['matchedBy'],
): SubtitleBinding {
  return {
    videoId,
    basename: subtitle.basename,
    extension: subtitle.extension,
    lang: parsed.lang,
    label: parsed.label,
    langKnown: isKnownLanguage(parsed.lang),
    needsConversion: subtitle.extension.toLowerCase() !== SERVABLE_EXTENSION,
    matchedBy,
  };
}

/**
 * Binds every sidecar in one folder to the videos in that folder.
 *
 * @param videos videos sitting in the same directory
 * @param subtitles subtitle files sitting in the same directory
 */
export function matchSubtitles(
  videos: VideoCandidate[],
  subtitles: SubtitleCandidate[],
): SubtitleMatchResult {
  const bindings: SubtitleBinding[] = [];
  const unmatched: UnmatchedSubtitle[] = [];

  for (const subtitle of subtitles) {
    const parsed = parseSubtitleName(subtitle.basename);

    if (!parsed) {
      unmatched.push({
        basename: subtitle.basename,
        extension: subtitle.extension,
        reason: 'unparseable-name',
      });
      continue;
    }

    // Rule one: the stem is the video's filename, exactly.
    const exact = videos.filter((candidate) => candidate.basename === parsed.stem);
    if (exact.length === 1) {
      bindings.push(bindingFor(subtitle, parsed, exact[0].id, 'exact-stem'));
      continue;
    }

    // Rule two: the stem is the video's *title* — the filename with any order
    // prefix and release tags removed. That is how a sidecar downloaded
    // separately from the video usually arrives: `Philosopher's Stone_en_...`
    // next to `01 - Philosopher's Stone.mp4`. Both sides go through the same
    // normalisation so the comparison is symmetric.
    const stemTitle = titleOf(parsed.stem);
    const byTitle = videos.filter((candidate) => titleOf(candidate.basename) === stemTitle);

    if (byTitle.length === 1) {
      bindings.push(bindingFor(subtitle, parsed, byTitle[0].id, 'cleaned-title'));
      continue;
    }

    if (byTitle.length > 1) {
      // Two videos in one folder cleaning to the same title, and no exact stem
      // to break the tie. Guessing here binds the wrong language to the wrong
      // episode, which is worse than reporting it.
      unmatched.push({
        basename: subtitle.basename,
        extension: subtitle.extension,
        reason: 'ambiguous',
        candidateVideoIds: byTitle.map((candidate) => candidate.id),
      });
      continue;
    }

    unmatched.push({
      basename: subtitle.basename,
      extension: subtitle.extension,
      reason: 'no-match',
    });
  }

  return { bindings, unmatched };
}
