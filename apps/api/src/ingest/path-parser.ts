/**
 * Turns a path under `MEDIA_ROOT` into what the library should make of it.
 *
 * Pure on purpose — no filesystem, no database, no clock. This is the highest
 * risk logic in the ingest pipeline (get it wrong and the whole library files
 * itself under the wrong collection) and the cheapest thing in the app to test
 * exhaustively, so it is written and tested before anything calls it.
 *
 * The folder convention it enforces:
 *
 *   media/<drive>/<item>/file.mp4                video straight in an item folder
 *   media/<drive>/<item>/<season>/file.mp4       video inside a season of an item
 *   media/<drive>/file.mp4                       an issue — loose on the drive, triage it
 *   media/file.mp4                               an issue — nothing lives at the root
 *   anything deeper                              an issue
 *
 * The **drive** is the top level: in production each one is a symlink to a
 * different physical disk. It is only where the bytes live and is never a
 * collection. Whether an item folder becomes a collection is decided by what
 * is inside it, which needs the whole folder at once and therefore lives in
 * `structure.ts` rather than here.
 */

/** Containers we are willing to ingest. Playability is a later question (step 10). */
export const VIDEO_EXTENSIONS = ['mp4', 'mkv', 'm4v', 'mov', 'avi', 'webm'] as const;

/** Sidecar subtitle formats. Only `vtt` is servable as-is; the rest get converted in step 11. */
export const SUBTITLE_EXTENSIONS = ['vtt', 'srt', 'ass', 'ssa'] as const;

/** Half-written files. Not mistakes — files to wait for. */
const PARTIAL_EXTENSIONS = ['part', 'crdownload', 'tmp', 'download', 'partial'] as const;

const SEASON_PATTERN = /^(?:season|series|s)[\s._-]*(\d{1,3})$/i;
const ORDER_PATTERN = /^(\d{1,3})\s*[-._)]\s*(.+)$/;

/**
 * Release tags, matched as whole tokens only — stripping substrings would eat
 * real titles ("Aachen" contains "aac").
 *
 * Deliberately excluded: EXTENDED, REMASTERED, UNCUT, DIRECTORS CUT. Those
 * describe the cut rather than the encode, and someone keeping two versions of
 * a film needs them to stay distinguishable.
 */
const RELEASE_TAG_PATTERNS: RegExp[] = [
  /^\d{3,4}p$/i, // 720p, 1080p, 2160p
  /^4k$/i,
  /^x26[45]$/i,
  /^h\.?26[45]$/i,
  /^(?:hevc|avc|xvid|divx)$/i,
  /^(?:web-?dl|web-?rip|blu-?ray|br-?rip|bd-?rip|dvd-?rip|hd-?tv|remux|hdrip)$/i,
  /^(?:aac|ac3|eac3|dts(?:-hd)?|truehd|atmos|flac|mp3)$/i,
  /^ddp?\d(?:\.\d)?$/i, // DD5.1, DDP5.1
  /^\d{1,2}bit$/i,
  /^hdr\d*$/i,
  /^(?:proper|repack|internal|limited)$/i,
];

export interface SeasonInfo {
  /** The folder name, exactly as it appears on disk. */
  folder: string;
  /** Parsed season number, or null when the folder name did not say. */
  number: number | null;
  /** Display title — always the folder name; the admin renames it if they care. */
  title: string;
  /** True when the number could not be read, so step 9 can raise an issue. */
  needsReview: boolean;
}

export type MediaPath =
  | {
      kind: 'video';
      /** Path relative to MEDIA_ROOT, exactly as given. This is the `storageKey`. */
      storageKey: string;
      /** Top-level folder — a physical disk in production, never a collection. */
      driveFolder: string;
      /** The folder the item lives in. What it becomes is `structure.ts`'s decision. */
      itemFolder: string;
      season: SeasonInfo | null;
      basename: string;
      extension: string;
      orderIndex: number | null;
      title: string;
    }
  | {
      kind: 'subtitle';
      relPath: string;
      driveFolder: string;
      itemFolder: string;
      season: SeasonInfo | null;
      basename: string;
      extension: string;
    }
  | { kind: 'ignored'; relPath: string; reason: 'dotfile' | 'partial' | 'unknown-extension' }
  | {
      kind: 'issue';
      relPath: string;
      reason: 'root-level-file' | 'loose-drive-file' | 'too-deep' | 'empty-path';
    };

/**
 * Splits a relative path into segments.
 *
 * Only `/` separates. A backslash is a legal character in a Linux filename, and
 * this repo lives on the Linux filesystem, so treating it as a separator would
 * corrupt real names.
 */
function segmentsOf(relPath: string): string[] {
  return relPath
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.');
}

function splitExtension(filename: string): { basename: string; extension: string } {
  const dot = filename.lastIndexOf('.');
  // A leading dot is a hidden file, not an extension.
  if (dot <= 0) return { basename: filename, extension: '' };

  return { basename: filename.slice(0, dot), extension: filename.slice(dot + 1).toLowerCase() };
}

/** Strips one release tag token, or returns null if the token is part of the title. */
function isReleaseTag(token: string): boolean {
  return RELEASE_TAG_PATTERNS.some((pattern) => pattern.test(token));
}

/**
 * Makes a filename stem presentable: separators back to spaces, scene noise
 * removed, whitespace collapsed.
 *
 * Never returns an empty string — a name made entirely of tags is more useful
 * shown as-is than blanked, and an admin can rename it.
 */
export function cleanTitle(raw: string): string {
  const withoutGroups = raw.replace(/\[[^\]]*\]/g, ' ');

  const spaced = withoutGroups.replace(/[_.]+/g, ' ');

  const kept = spaced
    .split(/\s+/)
    .filter((token) => token.length > 0 && !isReleaseTag(token))
    .join(' ')
    .trim();

  return kept.length > 0 ? kept : raw.trim();
}

/**
 * Reads a season number out of a folder name.
 *
 * A folder it cannot read is not an error: the season still ingests with
 * `number = null` and `needsReview`, because guessing which season "Specials"
 * is would be worse than asking.
 */
export function parseSeasonFolder(folder: string): SeasonInfo {
  const match = SEASON_PATTERN.exec(folder.trim());
  const number = match ? Number.parseInt(match[1], 10) : null;

  return { folder, number, title: folder, needsReview: number === null };
}

/**
 * Splits a leading episode/track number off a filename stem.
 *
 * A separator is required, so `01 Philosophers Stone` keeps its number — that
 * also protects titles which genuinely begin with a number.
 */
export function parseOrderAndTitle(basename: string): {
  orderIndex: number | null;
  title: string;
} {
  const match = ORDER_PATTERN.exec(basename.trim());

  if (!match) return { orderIndex: null, title: cleanTitle(basename) };

  return { orderIndex: Number.parseInt(match[1], 10), title: cleanTitle(match[2]) };
}

function classify(extension: string, basename: string): 'video' | 'subtitle' | MediaPath['kind'] {
  if (basename.startsWith('.')) return 'ignored';
  if ((PARTIAL_EXTENSIONS as readonly string[]).includes(extension)) return 'ignored';
  if ((VIDEO_EXTENSIONS as readonly string[]).includes(extension)) return 'video';
  if ((SUBTITLE_EXTENSIONS as readonly string[]).includes(extension)) return 'subtitle';
  return 'ignored';
}

function ignoredReason(
  extension: string,
  filename: string,
): 'dotfile' | 'partial' | 'unknown-extension' {
  if (filename.startsWith('.')) return 'dotfile';
  if ((PARTIAL_EXTENSIONS as readonly string[]).includes(extension)) return 'partial';
  return 'unknown-extension';
}

/** The whole convention in one function. See the module comment for the shapes. */
export function parseMediaPath(relPath: string): MediaPath {
  const segments = segmentsOf(relPath);

  if (segments.length === 0) {
    return { kind: 'issue', relPath, reason: 'empty-path' };
  }

  const filename = segments[segments.length - 1];
  const { basename, extension } = splitExtension(filename);
  const kind = classify(extension, filename);

  /**
   * A dot anywhere in the path hides the whole branch, not just a file. Upload
   * staging is `<drive>/.uploads/`, and a half-written file there must never be
   * read as content — the scanner skips dot directories, and this keeps the
   * parser saying the same thing to everything else that asks it.
   */
  if (kind !== 'ignored' && segments.some((segment) => segment.startsWith('.'))) {
    return { kind: 'ignored', relPath, reason: 'dotfile' };
  }

  /**
   * Ignored files are ignored wherever they sit — **before** the depth rules.
   *
   * The other order raises an issue for every `.DS_Store`, `Thumbs.db` or
   * `.gitkeep` that happens to be at the wrong level, which buries the real
   * problems in an admin's list. Only files the library would otherwise have
   * ingested are worth complaining about.
   */
  if (kind === 'ignored') {
    return { kind: 'ignored', relPath, reason: ignoredReason(extension, filename) };
  }

  if (segments.length === 1) {
    // Nothing lives at the root — everything sits on a drive.
    return { kind: 'issue', relPath, reason: 'root-level-file' };
  }

  if (segments.length === 2) {
    /**
     * Loose in a drive root. A drive holds unrelated things, so there is no
     * folder for the file to take a suggestion from and nothing to say whether
     * it belongs with its neighbours — an admin places it. Reported as its own
     * reason so the triage queue can tell it from a root-level file.
     */
    return { kind: 'issue', relPath, reason: 'loose-drive-file' };
  }

  if (segments.length > 4) {
    return { kind: 'issue', relPath, reason: 'too-deep' };
  }

  const driveFolder = segments[0];
  const itemFolder = segments[1];
  const season = segments.length === 4 ? parseSeasonFolder(segments[2]) : null;

  if (kind === 'subtitle') {
    return { kind: 'subtitle', relPath, driveFolder, itemFolder, season, basename, extension };
  }

  const { orderIndex, title } = parseOrderAndTitle(basename);

  return {
    kind: 'video',
    // Preserved verbatim: this becomes `storageKey`, which reconcile is keyed
    // on, so any normalisation here would break move detection.
    storageKey: relPath,
    driveFolder,
    itemFolder,
    season,
    basename,
    extension,
    orderIndex,
    title,
  };
}
