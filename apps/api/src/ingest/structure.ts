/**
 * Decides what an item folder should become: a standalone video, or a
 * collection.
 *
 * Pure — no filesystem, no database, no clock — and separate from
 * `path-parser.ts` for one reason: the decision needs the **whole folder at
 * once**. A single path cannot tell you whether its neighbour exists, and
 * "one video in a folder" versus "two videos in a folder" is exactly the
 * difference between a film and a collection.
 *
 * The rules, given an item folder under a drive:
 *
 *   holds season folders     → collection (a series), whatever the video count
 *   holds 2+ videos          → collection
 *   holds exactly 1 video    → standalone video, no collection
 *
 * What comes out is a *proposal*. The folder layout is only ever an initial
 * suggestion: reconcile applies a proposal when it first discovers a file and
 * never re-applies it afterwards, so an admin who reshapes the library keeps
 * their arrangement across every later scan.
 */

import { cleanTitle, type MediaPath, type SeasonInfo } from './path-parser';

export interface ProposedSeason extends SeasonInfo {
  /** `<drive>/<item>/<season>` — what the Season row's folderKey becomes. */
  folderKey: string;
}

export interface ProposedVideo {
  /** Relative to MEDIA_ROOT, verbatim from the parser. */
  storageKey: string;
  title: string;
  orderIndex: number | null;
  /** The season folder name, or null for a video sitting directly in the item folder. */
  seasonFolder: string | null;
}

export interface Proposal {
  kind: 'standalone' | 'collection';
  /** `<drive>/<item>` — the folder this proposal is about, and a Collection's folderKey. */
  folderKey: string;
  driveFolder: string;
  /** Suggested title, from the folder name. */
  title: string;
  seasons: ProposedSeason[];
  videos: ProposedVideo[];
}

type VideoPath = Extract<MediaPath, { kind: 'video' }>;

/**
 * `<drive>/<item>` — the identity of an item folder.
 *
 * Keyed on the drive as well as the folder because two disks may each hold an
 * `Avatar`, and they are two different things.
 */
export function itemFolderKey(parsed: {
  driveFolder: string;
  itemFolder: string;
}): string {
  return `${parsed.driveFolder}/${parsed.itemFolder}`;
}

/**
 * Groups parsed paths by item folder and decides each folder on its own
 * contents.
 *
 * Anything that is not a video is dropped here: sidecars are bound to videos by
 * the subtitle matcher, and issues are triage rather than structure. A folder
 * holding only sidecars proposes nothing, because it has no video to be about.
 */
export function proposeStructure(parsed: MediaPath[]): Proposal[] {
  const byFolder = new Map<string, VideoPath[]>();

  for (const path of parsed) {
    if (path.kind !== 'video') continue;

    // Keyed on drive *and* folder: two disks may each hold an `Avatar`, and
    // they are two different things.
    const folderKey = `${path.driveFolder}/${path.itemFolder}`;
    const group = byFolder.get(folderKey);

    if (group) group.push(path);
    else byFolder.set(folderKey, [path]);
  }

  return [...byFolder.entries()]
    .map(([folderKey, videos]) => toProposal(folderKey, videos))
    .sort((left, right) => compare(left.folderKey, right.folderKey));
}

function toProposal(folderKey: string, videos: VideoPath[]): Proposal {
  const seasons = collectSeasons(folderKey, videos);
  const { driveFolder, itemFolder } = videos[0];
  const title = cleanTitle(itemFolder);

  /**
   * A season folder means a series even with one episode in it. Someone who has
   * ripped the first episode has a show, and calling it a film would mean the
   * next scan had to undo a decision it already made — which it never does.
   */
  const kind = seasons.length > 0 || videos.length > 1 ? 'collection' : 'standalone';

  return {
    kind,
    folderKey,
    driveFolder,
    title,
    seasons,
    videos: videos
      .map((video) => toProposedVideo(video, kind, title))
      .sort((left, right) => compareVideos(left, right, seasons)),
  };
}

function toProposedVideo(video: VideoPath, kind: Proposal['kind'], folderTitle: string): ProposedVideo {
  return {
    storageKey: video.storageKey,
    /**
     * A standalone video *is* its folder, so the folder's name is the better
     * title — it is what a person typed, where the filename is whatever the
     * release was called. Inside a collection the filename is the only thing
     * that tells one video from another.
     */
    title: kind === 'standalone' ? folderTitle : video.title,
    orderIndex: video.orderIndex,
    seasonFolder: video.season?.folder ?? null,
  };
}

function collectSeasons(folderKey: string, videos: VideoPath[]): ProposedSeason[] {
  const seasons = new Map<string, ProposedSeason>();

  for (const video of videos) {
    if (!video.season || seasons.has(video.season.folder)) continue;

    seasons.set(video.season.folder, {
      ...video.season,
      folderKey: `${folderKey}/${video.season.folder}`,
    });
  }

  return [...seasons.values()].sort(compareSeasons);
}

/**
 * Numbered seasons in order, then the ones ingest could not read.
 *
 * A null number means "could not tell", not "season zero" — the same rule
 * `nextEpisode` uses for an unnumbered episode. Ties break on the folder name so
 * the order is total and a rescan cannot reshuffle the list.
 */
function compareSeasons(left: ProposedSeason, right: ProposedSeason): number {
  if (left.number !== right.number) {
    if (left.number === null) return 1;
    if (right.number === null) return -1;
    return left.number - right.number;
  }

  return compare(left.folder, right.folder);
}

/**
 * Season, then order index, then title, then storage key.
 *
 * Total on purpose: two videos can share a season and an order index (or have
 * none at all), and a list that reorders itself between identical scans reads as
 * a rendering bug for weeks. The storage key is unique, so it settles every tie.
 *
 * Title comes before the key because a folder of films has no episode numbers,
 * and falling straight through to the path puts `Avatar The Way Of Water` ahead
 * of `Avatar` — a space sorts below a dot. Deterministic, but not what anyone
 * would call sorted.
 */
function compareVideos(
  left: ProposedVideo,
  right: ProposedVideo,
  seasons: ProposedSeason[],
): number {
  const rank = (folder: string | null) =>
    folder === null ? -1 : seasons.findIndex((season) => season.folder === folder);

  const bySeason = rank(left.seasonFolder) - rank(right.seasonFolder);
  if (bySeason !== 0) return bySeason;

  if (left.orderIndex !== right.orderIndex) {
    if (left.orderIndex === null) return 1;
    if (right.orderIndex === null) return -1;
    return left.orderIndex - right.orderIndex;
  }

  const byTitle = compare(left.title, right.title);
  if (byTitle !== 0) return byTitle;

  return compare(left.storageKey, right.storageKey);
}

/** Ordinary code-unit comparison — stable across runs, unlike locale collation. */
function compare(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
