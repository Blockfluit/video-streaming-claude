import { resolve } from 'node:path';

import { MAX_UPLOAD_BYTES as MAX_UPLOAD_BYTES_DEFAULT } from '@video/shared';
import { z } from 'zod';

/**
 * The environment this server actually reads, checked once at boot.
 *
 * Configuration drifts — that is why `StorageService` refuses to start when
 * `DERIVED_ROOT` resolves inside `MEDIA_ROOT`, rather than trusting the deploy.
 * The same argument applies to the rest of it, and until this file existed the
 * contract had come apart in three directions at once: `MAX_UPLOAD_BYTES` was
 * documented as configuration and was a compile-time constant nothing read;
 * `TRANSCODE_CONCURRENCY` was documented and read nowhere at all; and
 * `TRUST_PROXY` was read in `main.ts` and documented in neither env file,
 * despite deciding whether the rate limiter can see a client's real address.
 *
 * **Validation only — never transformation.** `validateEnv` returns the raw
 * object it was given rather than the parsed one, so every existing
 * `config.get<string>(…)` keeps receiving exactly the string it received
 * before. A schema that coerced `PORT` to a number here would hand a number to
 * a caller that has always been given text, which is a behaviour change smuggled
 * in under a safety improvement.
 *
 * Everything is optional. Nothing here is made newly required: the stubbed-HTTP
 * test tier boots the whole `AppModule` without a `DATABASE_URL`, so demanding
 * one would fail a suite rather than catch a misconfiguration. What this does
 * catch is the value that is *present and malformed* — a typo'd `TRUST_PROXY`,
 * a `MAX_UPLOAD_BYTES` with a stray comma — which previously either did nothing
 * or failed much later and somewhere else.
 */

/** A whole number in a string, the shape every numeric variable arrives in. */
const numericText = z
  .string()
  .regex(/^\d+$/, 'must be a whole number')
  .refine((value) => Number.isSafeInteger(Number(value)), 'is too large to be exact');

const nonEmpty = z.string().trim().min(1, 'must not be blank');

/** `true`/`false`, or a hop count. Anything else silently disables the setting. */
const trustProxy = z
  .string()
  .refine(
    (value) => value === 'true' || value === 'false' || /^\d+$/.test(value),
    'must be "true", "false", or a number of proxy hops',
  );

export const envSchema = z.looseObject({
  NODE_ENV: z.string().optional(),
  PORT: numericText.optional(),
  DATABASE_URL: nonEmpty.optional(),
  SESSION_SECRET: nonEmpty.optional(),
  TRUST_PROXY: trustProxy.optional(),

  MEDIA_ROOT: nonEmpty.optional(),
  DERIVED_ROOT: nonEmpty.optional(),
  BOOTSTRAP_TOKEN_FILE: nonEmpty.optional(),
  MAX_UPLOAD_BYTES: numericText.optional(),
  INGEST_WATCHER_ENABLED: z.enum(['true', 'false']).optional(),

  FFMPEG_PATH: nonEmpty.optional(),
  FFPROBE_PATH: nonEmpty.optional(),
  TRANSCODE_PRESET: nonEmpty.optional(),
  // x264's scale. 0 is lossless and 51 is unwatchable; the default is 25.
  TRANSCODE_CRF: numericText.refine((value) => Number(value) <= 51, 'must be 51 or less').optional(),

  TMDB_API_TOKEN: nonEmpty.optional(),
  TMDB_LANGUAGE: nonEmpty.optional(),
  TMDB_IMAGE_SIZE: nonEmpty.optional(),
  TMDB_CERTIFICATION_COUNTRY: nonEmpty.optional(),

  OPENSUBTITLES_API_KEY: nonEmpty.optional(),
  OPENSUBTITLES_USERNAME: nonEmpty.optional(),
  OPENSUBTITLES_PASSWORD: nonEmpty.optional(),
  OPENSUBTITLES_USER_AGENT: nonEmpty.optional(),
});

/**
 * Handed to `ConfigModule.forRoot({ validate })`.
 *
 * Names every offending variable in one message rather than failing on the
 * first: an operator fixing a deploy wants the whole list, not one round trip
 * per typo.
 */
export function validateEnv(raw: Record<string, unknown>): Record<string, unknown> {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join('.')} ${issue.message}`)
      .join('; ');

    throw new Error(`Invalid environment: ${problems}`);
  }

  return raw;
}

/**
 * Where the two storage roots live, relative to the API's own working directory.
 *
 * Here rather than in `StorageService` because one caller cannot reach that
 * service: multer's `diskStorage` destination is evaluated when the uploads
 * controller class is *defined*, before dependency injection exists. That caller
 * used to resolve `process.env.MEDIA_ROOT ?? '../../media'` itself — a second
 * copy of the default, in the one module that must not disagree with the first,
 * since it decides where a two-gigabyte upload lands.
 */
export const ROOT_DEFAULTS = { media: '../../media', derived: '../../derived' } as const;

export function resolveRoot(kind: keyof typeof ROOT_DEFAULTS, configured?: string): string {
  return resolve(process.cwd(), configured?.trim() || ROOT_DEFAULTS[kind]);
}

/**
 * The upload ceiling, in bytes.
 *
 * Read from the environment at last, with the shared constant as the default —
 * the `.env.example` entry has always described this as configuration and
 * nothing had ever read it, so raising the limit did nothing and said nothing.
 * The shared constant stays the default because the browser needs the same
 * number to refuse a file before spending an hour uploading it, and it has no
 * way to ask this process what the server is set to.
 */
export function maxUploadBytes(): number {
  const configured = process.env.MAX_UPLOAD_BYTES?.trim();
  if (!configured) return MAX_UPLOAD_BYTES_DEFAULT;

  const bytes = Number(configured);
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : MAX_UPLOAD_BYTES_DEFAULT;
}
