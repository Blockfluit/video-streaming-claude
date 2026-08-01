import { describe, expect, it } from 'vitest'

import { DEFAULT_REDIRECT, safeRedirect } from './safe-redirect'

describe('safeRedirect', () => {
  it('passes an ordinary in-app path through', () => {
    expect(safeRedirect('/c/the-show/season-1/pilot')).toBe('/c/the-show/season-1/pilot')
  })

  it('keeps a query string and fragment', () => {
    expect(safeRedirect('/browse?tag=noir#top')).toBe('/browse?tag=noir#top')
  })

  // Slugs are full of hyphens; a careless control-character class eats them.
  it('keeps a path full of hyphens', () => {
    expect(safeRedirect('/c/the-big-sky/season-1/the-one-with-the-dog')).toBe(
      '/c/the-big-sky/season-1/the-one-with-the-dog',
    )
  })

  it('falls back home when there is nothing to go back to', () => {
    expect(safeRedirect(undefined)).toBe(DEFAULT_REDIRECT)
    expect(safeRedirect('')).toBe(DEFAULT_REDIRECT)
    expect(safeRedirect(['/a', '/b'])).toBe(DEFAULT_REDIRECT)
  })

  /**
   * The whole reason this exists: the value arrives through the URL, so anyone
   * can write it, and following it after authenticating is an open redirect.
   */
  describe('refuses to leave the site', () => {
    it('rejects an absolute URL', () => {
      expect(safeRedirect('https://evil.example/steal')).toBe(DEFAULT_REDIRECT)
    })

    // Protocol-relative: browsers read this as another host entirely.
    it('rejects a protocol-relative URL', () => {
      expect(safeRedirect('//evil.example/steal')).toBe(DEFAULT_REDIRECT)
    })

    // Some browsers normalise the backslash to a slash before navigating.
    it('rejects a backslash-prefixed path', () => {
      expect(safeRedirect('/\\evil.example')).toBe(DEFAULT_REDIRECT)
    })

    it('rejects a scheme that is not http at all', () => {
      expect(safeRedirect('javascript:alert(1)')).toBe(DEFAULT_REDIRECT)
    })

    it('rejects a path carrying a control character', () => {
      expect(safeRedirect('/browse\nLocation: https://evil.example')).toBe(DEFAULT_REDIRECT)
    })
  })
})
