import { describe, expect, it } from 'vitest'

import { quotaNotice } from './subtitle-quota'

describe('quotaNotice', () => {
  it('says how many are left', () => {
    expect(quotaNotice({ remaining: 18, allowed: 20 })).toEqual({
      text: '18 of 20 downloads left today.',
      exhausted: false,
    })
  })

  it('has nothing to say when the server has no allowance at all', () => {
    // A key with no account can search and never download. There is no number,
    // which is not the same as a number that has run out.
    expect(quotaNotice(null)).toBeNull()
    expect(quotaNotice(undefined)).toBeNull()
  })

  it('distinguishes an exhausted allowance from an absent one', () => {
    const notice = quotaNotice({ remaining: 0, allowed: 20 })

    expect(notice?.exhausted).toBe(true)
    expect(notice?.text).toContain('used up')
    // The reset is the one thing an admin can act on, so it gets said.
    expect(notice?.text).toContain('resets')
  })

  it('treats a negative remainder as spent rather than owed', () => {
    expect(quotaNotice({ remaining: -1, allowed: 20 })?.exhausted).toBe(true)
  })

  it('counts the last one as still available', () => {
    // Off by one here disables the button while a download is still allowed.
    expect(quotaNotice({ remaining: 1, allowed: 20 })?.exhausted).toBe(false)
  })
})
