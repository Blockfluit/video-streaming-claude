/**
 * What to say about a subtitle provider's remaining download allowance.
 *
 * Pure, because the distinction it draws is the easy one to get wrong: **no
 * allowance and an exhausted allowance are different things.** A server holding
 * an API key but no account can search and never download, so it has no number
 * at all — rendering that as "0 of 0 left" would tell an admin they had spent
 * something they never had, and send them looking for a reset that never comes.
 */

export interface SubtitleQuota {
  remaining: number
  allowed: number
}

export interface QuotaNotice {
  text: string
  /** Whether installing should be refused up front rather than left to fail. */
  exhausted: boolean
}

export function quotaNotice(quota: SubtitleQuota | null | undefined): QuotaNotice | null {
  if (!quota) return null

  // Defensive about the sign: a provider reporting a negative remainder means
  // spent, not owed.
  if (quota.remaining <= 0) {
    return {
      text: `Today's ${quota.allowed} downloads are used up. Searching still works, and the allowance resets 24 hours after the first one.`,
      exhausted: true,
    }
  }

  return {
    text: `${quota.remaining} of ${quota.allowed} downloads left today.`,
    exhausted: false,
  }
}
