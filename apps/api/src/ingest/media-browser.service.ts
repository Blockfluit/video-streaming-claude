import { Injectable, NotFoundException } from '@nestjs/common';

import { StorageService } from '../common/storage.service';
import { PrismaService } from '../prisma/prisma.service';
import { parseMediaPath } from './path-parser';
import { scanMediaRoot } from './media-scanner';
import { proposeStructure, type Proposal } from './structure';

/**
 * Browsing the drives as they actually are, and saying what the library would
 * make of what it finds.
 *
 * Ingest happens on its own — this is the screen that explains it. A drive holds
 * unrelated things and the folder layout is only a suggestion, so an admin needs
 * to see the disk and the library side by side: which folders became
 * collections, which videos stand alone, and which files are sitting loose
 * where nothing can decide for them.
 *
 * Read-only. Importing is `reconcile.run()` like everything else; there is no
 * second path that creates rows.
 */

export interface BrowseEntry {
  name: string;
  /** Relative to MEDIA_ROOT. */
  path: string;
  kind: 'drive' | 'folder' | 'video' | 'subtitle' | 'other';
  /** For a video: whether the library already knows this file. */
  imported?: boolean;
  videoId?: string;
}

export interface BrowseResult {
  path: string;
  /** Null at the root; otherwise the parent folder, so the UI can offer "up". */
  parent: string | null;
  entries: BrowseEntry[];
  /** What the library would make of this folder, when it is an item folder. */
  proposal: Proposal | null;
}

@Injectable()
export class MediaBrowserService {
  constructor(
    private readonly storage: StorageService,
    private readonly prisma: PrismaService,
  ) {}

  async browse(path: string): Promise<BrowseResult> {
    const key = normalise(path);

    // Every path goes through StorageService, which is the only thing that
    // joins them and the only thing that can say a key is inside its root. The
    // root itself is not a key, so it is the one path not checked that way.
    if (key !== '' && !(await this.storage.exists('media', key))) {
      throw new NotFoundException('No such folder');
    }

    const directories = await this.storage.listDirectories('media', key);
    const files = await this.storage.listFiles('media', key);

    const depth = key === '' ? 0 : key.split('/').length;

    const entries: BrowseEntry[] = directories.map((name) => ({
      name,
      path: key === '' ? name : `${key}/${name}`,
      // The top level is drives; everything below is an ordinary folder.
      kind: depth === 0 ? ('drive' as const) : ('folder' as const),
    }));

    const known = await this.prisma.video.findMany({
      where: { storageKey: { in: files.map((name) => (key === '' ? name : `${key}/${name}`)) } },
      select: { id: true, storageKey: true },
    });
    const byKey = new Map(known.map((video) => [video.storageKey, video.id]));

    for (const name of files) {
      const filePath = key === '' ? name : `${key}/${name}`;
      const parsed = parseMediaPath(filePath);

      entries.push({
        name,
        path: filePath,
        kind:
          parsed.kind === 'video'
            ? 'video'
            : parsed.kind === 'subtitle'
              ? 'subtitle'
              : // An issue is still a video file to a person looking at a folder;
                // what makes it an issue is where it sits, which the proposal and
                // the issue list already say.
                isVideoName(name)
                ? 'video'
                : 'other',
        ...(byKey.has(filePath)
          ? { imported: true, videoId: byKey.get(filePath) }
          : isVideoName(name)
            ? { imported: false }
            : {}),
      });
    }

    entries.sort(
      (left, right) => rank(left.kind) - rank(right.kind) || compare(left.name, right.name),
    );

    return {
      path: key,
      parent: key === '' ? null : key.slice(0, Math.max(0, key.lastIndexOf('/'))),
      entries,
      proposal: await this.proposalFor(key, depth),
    };
  }

  /**
   * What this folder would become.
   *
   * Only meaningful for an item folder — `<drive>/<item>` — because that is the
   * level the shape rule applies at. Scanning the folder itself rather than the
   * whole root keeps the answer about what the admin is looking at.
   */
  private async proposalFor(key: string, depth: number): Promise<Proposal | null> {
    if (depth !== 2) return null;

    const scan = await scanMediaRoot(this.storage.rootPath('media'));
    const inFolder = scan.videos.filter((file) => file.relPath.startsWith(`${key}/`));

    const [proposal] = proposeStructure(inFolder.map((file) => file.parsed));
    return proposal ?? null;
  }
}

function normalise(path: string): string {
  return path
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== '.')
    .join('/');
}

function isVideoName(name: string): boolean {
  const parsed = parseMediaPath(`drive/folder/${name}`);
  return parsed.kind === 'video';
}

/** Folders first, then videos, then everything else — how a file browser reads. */
function rank(kind: BrowseEntry['kind']): number {
  if (kind === 'drive' || kind === 'folder') return 0;
  if (kind === 'video') return 1;
  return 2;
}

function compare(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
