import { languageName } from '../common/language';

/**
 * Sorting a container's subtitle streams into the ones that can become WebVTT
 * and the ones that cannot.
 *
 * The distinction is not cosmetic. `subrip` and `ass` are text and convert
 * cleanly; `hdmv_pgs_subtitle` and `dvd_subtitle` are **images**, and turning
 * those into text needs OCR. The honest options there are burning them in or
 * running OCR, both out of scope — so they are skipped and *reported*, rather
 * than silently dropped or allowed to fail the whole job.
 */

/** Codecs whose payload is text. */
const TEXT_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text', 'stl']);

export interface SubtitleStream {
  index: number;
  codec_type?: string;
  codec_name?: string;
  tags?: Record<string, string | undefined>;
  disposition?: Record<string, number | undefined>;
}

export interface ExtractableStream {
  /** Stream index within the container, for `-map 0:<index>`. */
  index: number;
  language: string;
  label: string;
  codec: string;
  isDefault: boolean;
}

export interface SkippedStream {
  index: number;
  codec: string;
  reason: 'bitmap';
}

export function classifySubtitleStreams(streams: SubtitleStream[]): {
  extractable: ExtractableStream[];
  skipped: SkippedStream[];
} {
  const extractable: ExtractableStream[] = [];
  const skipped: SkippedStream[] = [];

  for (const stream of streams) {
    if (stream.codec_type !== 'subtitle') continue;

    const codec = (stream.codec_name ?? '').toLowerCase();

    if (!TEXT_CODECS.has(codec)) {
      skipped.push({ index: stream.index, codec, reason: 'bitmap' });
      continue;
    }

    // Matroska uses `und` for an unlabelled track; following that keeps the
    // value meaningful rather than empty.
    const language = stream.tags?.language?.trim().toLowerCase() || 'und';

    extractable.push({
      index: stream.index,
      language,
      // A label is what the viewer picks from, so falling all the way back to
      // the index beats an empty entry in the menu.
      label: stream.tags?.title?.trim() || languageName(language) || `Track ${stream.index}`,
      codec,
      isDefault: stream.disposition?.default === 1,
    });
  }

  return { extractable, skipped };
}
