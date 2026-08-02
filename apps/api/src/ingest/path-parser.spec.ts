import {
  cleanTitle,
  parseMediaPath,
  parseOrderAndTitle,
  parseSeasonFolder,
  type MediaPath,
} from './path-parser';

/** Narrows the result so a wrong `kind` fails loudly instead of reading as undefined. */
function video(relPath: string): Extract<MediaPath, { kind: 'video' }> {
  const result = parseMediaPath(relPath);
  if (result.kind !== 'video') {
    throw new Error(`expected a video for ${relPath}, got ${result.kind}`);
  }
  return result;
}

describe('parseSeasonFolder', () => {
  it('reads the common spellings', () => {
    expect(parseSeasonFolder('Season 01')).toMatchObject({ number: 1 });
    expect(parseSeasonFolder('season 1')).toMatchObject({ number: 1 });
    expect(parseSeasonFolder('Series 2')).toMatchObject({ number: 2 });
    expect(parseSeasonFolder('S03')).toMatchObject({ number: 3 });
  });

  it('tolerates the separators people actually type', () => {
    expect(parseSeasonFolder('Season_04')).toMatchObject({ number: 4 });
    expect(parseSeasonFolder('Season.05')).toMatchObject({ number: 5 });
    expect(parseSeasonFolder('Season-06')).toMatchObject({ number: 6 });
    expect(parseSeasonFolder('Season07')).toMatchObject({ number: 7 });
  });

  it('keeps leading zeros out of the number', () => {
    expect(parseSeasonFolder('Season 007')).toMatchObject({ number: 7 });
  });

  it('keeps the folder name as the title either way', () => {
    expect(parseSeasonFolder('Season 01').title).toBe('Season 01');
    expect(parseSeasonFolder('Specials').title).toBe('Specials');
  });

  // Not an error: the season still ingests, it just needs an admin to say what
  // number it is. Guessing would be worse than asking.
  it('reports a folder it cannot read rather than guessing', () => {
    expect(parseSeasonFolder('Specials')).toMatchObject({ number: null });
    expect(parseSeasonFolder('Extras')).toMatchObject({ number: null });
    expect(parseSeasonFolder('Bonus Features')).toMatchObject({ number: null });
  });

  it('does not read a season number out of an unrelated word', () => {
    expect(parseSeasonFolder('Sopranos')).toMatchObject({ number: null });
    expect(parseSeasonFolder('Seasoning 3')).toMatchObject({ number: null });
  });

  it('refuses numbers too long to be a season', () => {
    expect(parseSeasonFolder('Season 1234')).toMatchObject({ number: null });
  });
});

describe('parseOrderAndTitle', () => {
  it('splits a leading number from the title', () => {
    expect(parseOrderAndTitle("01 - Philosopher's Stone")).toEqual({
      orderIndex: 1,
      title: "Philosopher's Stone",
    });
  });

  it('accepts the separators people use', () => {
    expect(parseOrderAndTitle('02. Chamber of Secrets').orderIndex).toBe(2);
    expect(parseOrderAndTitle('03_Prisoner of Azkaban').orderIndex).toBe(3);
    expect(parseOrderAndTitle('04) Goblet of Fire').orderIndex).toBe(4);
  });

  // The plan's regex requires a separator. A bare space is left alone, which
  // also protects titles that simply start with a number.
  it('leaves a number with no separator as part of the title', () => {
    expect(parseOrderAndTitle('01 Philosophers Stone')).toEqual({
      orderIndex: null,
      title: '01 Philosophers Stone',
    });
  });

  it('has no order when the name does not start with one', () => {
    expect(parseOrderAndTitle('Inception')).toEqual({ orderIndex: null, title: 'Inception' });
  });

  it('does not mistake a year for an order', () => {
    expect(parseOrderAndTitle('2001 - A Space Odyssey').orderIndex).toBeNull();
  });

  it('cleans the title it extracts', () => {
    expect(parseOrderAndTitle('01 - Some.Movie.1080p.x264').title).toBe('Some Movie');
  });
});

describe('cleanTitle', () => {
  it('turns separators back into spaces', () => {
    expect(cleanTitle('Some.Movie.Name')).toBe('Some Movie Name');
    expect(cleanTitle('Some_Movie_Name')).toBe('Some Movie Name');
  });

  it('collapses whitespace and trims', () => {
    expect(cleanTitle('  Some   Movie  ')).toBe('Some Movie');
  });

  it('strips resolution, codec and source tags', () => {
    expect(cleanTitle('Inception 1080p')).toBe('Inception');
    expect(cleanTitle('Inception.2160p.x265')).toBe('Inception');
    expect(cleanTitle('Inception WEB-DL')).toBe('Inception');
    expect(cleanTitle('Inception BluRay h264')).toBe('Inception');
    expect(cleanTitle('Inception HDTV XviD')).toBe('Inception');
  });

  it('strips audio and scene tags', () => {
    expect(cleanTitle('Inception AAC')).toBe('Inception');
    expect(cleanTitle('Inception DTS PROPER')).toBe('Inception');
    expect(cleanTitle('Inception REPACK')).toBe('Inception');
  });

  it('strips bracketed scene groups', () => {
    expect(cleanTitle('Inception [YTS.MX]')).toBe('Inception');
    expect(cleanTitle('Inception [1080p] [BluRay]')).toBe('Inception');
  });

  // The tags are only tags as whole words. Stripping substrings would eat real
  // titles — and these are deliberately multi-word, because the
  // never-blank-a-title fallback below would otherwise restore a single-token
  // title and hide the bug.
  it('does not strip a tag that is part of a real word', () => {
    expect(cleanTitle('The Aachen Story')).toBe('The Aachen Story');
    expect(cleanTitle('Blade Runner 2049')).toBe('Blade Runner 2049');
    expect(cleanTitle('Flacon And The Winter Soldier')).toBe('Flacon And The Winter Soldier');
    expect(cleanTitle('A Hidden Life')).toBe('A Hidden Life');
    expect(cleanTitle('Dust To Dust')).toBe('Dust To Dust');
  });

  // Words that describe the cut are part of what you are watching, unlike
  // 1080p — someone keeping both cuts needs to tell them apart.
  it('keeps edition words', () => {
    expect(cleanTitle('Blade Runner Extended')).toBe('Blade Runner Extended');
    expect(cleanTitle('Apocalypse Now Remastered')).toBe('Apocalypse Now Remastered');
  });

  it('never cleans a title away to nothing', () => {
    expect(cleanTitle('1080p')).toBe('1080p');
    expect(cleanTitle('[YTS.MX]')).toBe('[YTS.MX]');
  });

  it('is idempotent', () => {
    const once = cleanTitle('Some.Movie.1080p.x264');
    expect(cleanTitle(once)).toBe(once);
  });
});

/**
 * The layout, with the drive level in front of everything:
 *
 *   media/<drive>/<item>/file.mp4            a video in an item folder
 *   media/<drive>/<item>/<season>/file.mp4   a video in a season of an item
 *   media/<drive>/file.mp4                   loose on the drive — an issue to triage
 *   media/file.mp4                           an issue; nothing lives at the root
 *
 * A drive is a symlink to a physical disk in production. It is never a
 * collection — whether an item folder becomes one is decided by what is inside
 * it, which is `structure.ts`, not this file.
 */
describe('parseMediaPath', () => {
  describe('a video directly inside an item folder', () => {
    const result = video("disk1/Harry Potter/01 - Philosopher's Stone.mp4");

    it('separates the drive from the item folder', () => {
      expect(result.driveFolder).toBe('disk1');
      expect(result.itemFolder).toBe('Harry Potter');
    });

    it('has no season', () => {
      expect(result.season).toBeNull();
    });

    it('reads the order and title from the filename', () => {
      expect(result).toMatchObject({ orderIndex: 1, title: "Philosopher's Stone" });
    });

    it('keeps the path it was given as the storage key', () => {
      expect(result.storageKey).toBe("disk1/Harry Potter/01 - Philosopher's Stone.mp4");
    });
  });

  describe('a video inside a season', () => {
    const result = video('disk1/South Park/Season 01/01 - Cartman Gets an Anal Probe.mp4');

    it('records the drive, the item and the season', () => {
      expect(result.driveFolder).toBe('disk1');
      expect(result.itemFolder).toBe('South Park');
      expect(result.season).toMatchObject({ folder: 'Season 01', number: 1 });
    });

    it('still reads the order and title', () => {
      expect(result).toMatchObject({ orderIndex: 1, title: 'Cartman Gets an Anal Probe' });
    });
  });

  it('parses a lone film in its own folder without deciding what it becomes', () => {
    expect(video('disk1/Inception/Inception.mp4')).toMatchObject({
      driveFolder: 'disk1',
      itemFolder: 'Inception',
      season: null,
      orderIndex: null,
      title: 'Inception',
    });
  });

  // The season still ingests; the flag is what becomes an issue.
  it('flags a season folder it could not read, without refusing the video', () => {
    const result = video('disk1/South Park/Specials/01 - Pilot.mp4');

    expect(result.season).toMatchObject({ folder: 'Specials', number: null });
    expect(result.season?.needsReview).toBe(true);
  });

  describe('structural problems', () => {
    it('refuses a file at the root of the media folder', () => {
      expect(parseMediaPath('loose.mp4')).toEqual({
        kind: 'issue',
        reason: 'root-level-file',
        relPath: 'loose.mp4',
      });
    });

    /**
     * A video loose in a drive root is the case the library will not guess at.
     * A drive holds unrelated things, so the file has no folder to take a
     * suggestion from — an admin places it. Distinct from `root-level-file` so
     * the triage queue can say which of the two it is.
     */
    it('refuses a video loose in a drive root, as its own kind of problem', () => {
      expect(parseMediaPath('night-films/Chinatown (1974).mp4')).toEqual({
        kind: 'issue',
        reason: 'loose-drive-file',
        relPath: 'night-films/Chinatown (1974).mp4',
      });
    });

    it('treats a sidecar loose in a drive root the same way', () => {
      expect(parseMediaPath('night-films/Chinatown_en_English.srt')).toMatchObject({
        kind: 'issue',
        reason: 'loose-drive-file',
      });
    });

    it('refuses anything nested deeper than drive/item/season/file', () => {
      expect(parseMediaPath('disk1/A/B/C/d.mp4')).toMatchObject({
        kind: 'issue',
        reason: 'too-deep',
      });
      expect(parseMediaPath('disk1/A/B/C/D/e.mp4')).toMatchObject({
        kind: 'issue',
        reason: 'too-deep',
      });
    });

    it('refuses an empty path', () => {
      expect(parseMediaPath('').kind).toBe('issue');
    });
  });

  describe('files it should quietly skip', () => {
    it('ignores dotfiles', () => {
      expect(parseMediaPath('disk1/Harry Potter/.DS_Store')).toMatchObject({ kind: 'ignored' });
      expect(parseMediaPath('disk1/Harry Potter/.hidden.mp4')).toMatchObject({ kind: 'ignored' });
    });

    // A download in progress is not a mistake to report, it is a file to wait for.
    it('ignores partial downloads', () => {
      expect(parseMediaPath('disk1/Harry Potter/film.mp4.part')).toMatchObject({ kind: 'ignored' });
      expect(parseMediaPath('disk1/Harry Potter/film.mp4.crdownload')).toMatchObject({
        kind: 'ignored',
      });
      expect(parseMediaPath('disk1/Harry Potter/film.tmp')).toMatchObject({ kind: 'ignored' });
    });

    it('ignores extensions it does not know', () => {
      expect(parseMediaPath('disk1/Harry Potter/notes.txt')).toMatchObject({ kind: 'ignored' });
      expect(parseMediaPath('disk1/Harry Potter/poster.jpg')).toMatchObject({ kind: 'ignored' });
    });

    it('ignores a file with no extension at all', () => {
      expect(parseMediaPath('disk1/Harry Potter/README')).toMatchObject({ kind: 'ignored' });
    });

    /**
     * Ignoring beats the structural rules. Otherwise every `.DS_Store`,
     * `Thumbs.db` or `.gitkeep` at the wrong level becomes an issue in the
     * admin's list, burying the problems that actually need a person — which is
     * exactly what happened to `media/.gitkeep` on the first real run.
     */
    it('ignores them wherever they sit, rather than calling them structural problems', () => {
      expect(parseMediaPath('.gitkeep')).toMatchObject({ kind: 'ignored', reason: 'dotfile' });
      expect(parseMediaPath('.DS_Store')).toMatchObject({ kind: 'ignored' });
      expect(parseMediaPath('notes.txt')).toMatchObject({
        kind: 'ignored',
        reason: 'unknown-extension',
      });
      expect(parseMediaPath('disk1/.DS_Store')).toMatchObject({ kind: 'ignored' });
      expect(parseMediaPath('disk1/A/B/C/D/.DS_Store')).toMatchObject({ kind: 'ignored' });
      expect(parseMediaPath('disk1/A/B/C/D/notes.txt')).toMatchObject({ kind: 'ignored' });
      expect(parseMediaPath('disk1/A/B/C/D/film.mp4.part')).toMatchObject({ kind: 'ignored' });
    });

    // A video really is a structural problem at those depths.
    it('still reports a video at the wrong depth', () => {
      expect(parseMediaPath('loose.mp4')).toMatchObject({ kind: 'issue' });
      expect(parseMediaPath('disk1/loose.mp4')).toMatchObject({ kind: 'issue' });
      expect(parseMediaPath('disk1/A/B/C/D/film.mp4')).toMatchObject({ kind: 'issue' });
    });

    // The staging directory an upload writes into, and anything else dot-prefixed
    // on a drive, must never be read as content.
    it('ignores files staged in a drive upload directory', () => {
      expect(parseMediaPath('disk1/.uploads/half-a-film.mp4')).toMatchObject({ kind: 'ignored' });
    });
  });

  describe('subtitles', () => {
    it('recognises a sidecar rather than treating it as a video or a mistake', () => {
      expect(
        parseMediaPath("disk1/Harry Potter/01 - Philosopher's Stone_en_English.vtt"),
      ).toMatchObject({
        kind: 'subtitle',
        driveFolder: 'disk1',
        itemFolder: 'Harry Potter',
        season: null,
      });
    });

    it('recognises the formats that need converting too', () => {
      expect(parseMediaPath('disk1/Harry Potter/x_nl_Nederlands.srt').kind).toBe('subtitle');
      expect(parseMediaPath('disk1/Harry Potter/x_en_English.ass').kind).toBe('subtitle');
    });

    it('finds them inside seasons as well', () => {
      expect(parseMediaPath('disk1/South Park/Season 01/01 - Pilot_en_English.vtt')).toMatchObject({
        kind: 'subtitle',
        season: expect.objectContaining({ number: 1 }),
      });
    });
  });

  describe('video extensions', () => {
    it.each(['mp4', 'mkv', 'm4v', 'mov', 'avi', 'webm'])('accepts .%s', (extension) => {
      expect(parseMediaPath(`disk1/Film/Film.${extension}`).kind).toBe('video');
    });

    it('does not care about the case of the extension', () => {
      expect(parseMediaPath('disk1/Film/Film.MP4').kind).toBe('video');
      expect(parseMediaPath('disk1/Film/Film.MkV').kind).toBe('video');
    });
  });

  describe('paths as they actually arrive', () => {
    it('tolerates a leading ./ and duplicate slashes', () => {
      expect(video('./disk1/Harry Potter/film.mp4').itemFolder).toBe('Harry Potter');
      expect(video('disk1//Harry Potter/film.mp4').itemFolder).toBe('Harry Potter');
    });

    it('tolerates a leading slash', () => {
      expect(video('/disk1/Harry Potter/film.mp4').itemFolder).toBe('Harry Potter');
    });

    // Backslash is a legal character in a Linux filename, so it must not be
    // silently treated as a separator.
    it('does not treat a backslash as a separator', () => {
      expect(parseMediaPath('disk1\\Harry Potter\\film.mp4')).toMatchObject({
        kind: 'issue',
        reason: 'root-level-file',
      });
    });
  });
});
