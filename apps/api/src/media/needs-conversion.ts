/**
 * Decides whether a file needs transcoding before a browser can play it.
 *
 * The problem this solves: an `.mkv` carrying H.265 video, or 10-bit colour,
 * plays on almost nothing natively — and `<video>` reports that by showing a
 * black box with no error at all. Detecting it from the probe means the admin
 * sees a **Convert** button instead of discovering it during a film night.
 *
 * Pure, so the whole compatibility matrix is cheap to pin down. Nothing
 * transcodes automatically; this only raises the flag.
 */

export interface ConversionSignals {
  /** Lowercase container extension, without the dot. */
  extension: string;
  videoCodec: string | null;
  audioCodec: string | null;
  pixelFormat: string | null;
  /** ffprobe's `profile` for the video stream. Only meaningful for H.264. */
  videoProfile: string | null;
}

export type ConversionReason = 'container' | 'video-codec' | 'audio-codec' | 'pixel-format' | 'profile';

export interface ConversionVerdict {
  needed: boolean;
  reasons: ConversionReason[];
}

/** Containers no browser will play, whatever is inside them. */
const BAD_CONTAINERS = new Set(['mkv', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'm2ts', 'vob']);

const PLAYABLE_VIDEO_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1']);
const PLAYABLE_AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'vorbis']);

/**
 * H.264 profiles above High. These carry 10-bit or non-4:2:0 chroma, which is
 * the same problem as the pixel format check and what `-pix_fmt yuv420p` fixes.
 */
const UNPLAYABLE_H264_PROFILES = /^(high\s*10|high\s*4:2:2|high\s*4:4:4|predictive|cavlc)/i;

export function needsConversion(signals: ConversionSignals): ConversionVerdict {
  const reasons: ConversionReason[] = [];

  if (BAD_CONTAINERS.has(signals.extension.toLowerCase())) {
    reasons.push('container');
  }

  // A null means the probe failed or has not run. Flagging on that would queue
  // CPU-saturating work on a guess; leaving it alone shows the admin a probe
  // error they can act on. The container check above still applies, because it
  // needs no probe at all.
  if (signals.videoCodec !== null && !PLAYABLE_VIDEO_CODECS.has(signals.videoCodec.toLowerCase())) {
    reasons.push('video-codec');
  }

  if (signals.audioCodec !== null && !PLAYABLE_AUDIO_CODECS.has(signals.audioCodec.toLowerCase())) {
    reasons.push('audio-codec');
  }

  // Anything beyond 8-bit has no universal hardware decode support.
  if (signals.pixelFormat !== null && !is8Bit420(signals.pixelFormat)) {
    reasons.push('pixel-format');
  }

  // Only H.264 names profiles this way — VP9 and AV1 use numbered profiles
  // that would otherwise trip the pattern.
  if (
    signals.videoCodec?.toLowerCase() === 'h264' &&
    signals.videoProfile !== null &&
    UNPLAYABLE_H264_PROFILES.test(signals.videoProfile.trim())
  ) {
    reasons.push('profile');
  }

  return { needed: reasons.length > 0, reasons };
}

/** `yuv420p` and its aliases. Anything with a bit-depth suffix is not it. */
function is8Bit420(pixelFormat: string): boolean {
  return ['yuv420p', 'yuvj420p', 'nv12'].includes(pixelFormat.toLowerCase());
}
