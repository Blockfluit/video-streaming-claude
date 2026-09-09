import { z } from 'zod';

/**
 * The one admin-tunable app setting today: how many watched-or-listed
 * titles a viewer needs before "% Match" scores anything for them.
 */

/** Below this a "signal" is one afternoon of one show, not evidence of taste. */
export const MIN_TITLES_FOR_MATCH_FLOOR = 2;
/** Past this a small library needs a tenth of its catalogue watched first — not stricter, just off. */
export const MIN_TITLES_FOR_MATCH_CEILING = 50;

export const updateSettingsSchema = z.object({
  minTitlesForMatch: z.coerce
    .number()
    .int()
    .min(MIN_TITLES_FOR_MATCH_FLOOR)
    .max(MIN_TITLES_FOR_MATCH_CEILING),
});
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;
