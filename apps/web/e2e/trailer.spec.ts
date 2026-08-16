import type { Page } from '@playwright/test'
import { expect } from '@playwright/test'

import { test, visit } from './fixtures'

/**
 * Watching the trailer, as opposed to having one play behind the page text.
 *
 * The hero has played a trailer for a while and it has never been watchable:
 * cropped to the band, scrimmed twice so the text over it stays legible, and
 * silent because a browser will not start anything else. "Play the trailer" is a
 * thing people mean literally, and this dialog is where they can.
 *
 * Reduced motion is asked for **here**, explicitly, rather than inherited. It
 * suppresses the trailer that starts itself and has no business suppressing one
 * somebody pressed a button for, so running under it is what proves the two are
 * separate — and it keeps the ambient embed off the page, which is the only
 * other thing that could satisfy a locator for a YouTube iframe.
 *
 * Stated in the file because the config's global `reducedMotion: 'reduce'` was
 * measured **not** reaching this spec: `matchMedia` reported false inside it. The
 * old version of this test passed anyway, but only by accident — back then the
 * ambient iframe unmounted itself after four seconds of silence, so polling for
 * its absence eventually succeeded for entirely the wrong reason.
 */
test.describe('the trailer dialog', () => {
  test.use({ reducedMotion: 'reduce' })

  /**
   * Nothing leaves the machine. Narrow to the two hosts: a `*youtube*` glob also
   * catches Vite's own module requests, and the fixture watchdog fails the test
   * on any response ≥400 in any frame.
   */
  test.beforeEach(async ({ page }) => {
    await page.route(/youtube(-nocookie)?\.com/, route =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><title>stub</title>',
      }),
    )
  })

  interface Subject { id: string, slug: string, title: string }

  /** Chosen from the data, and given a trailer, because most titles have none. */
  async function aVideo(page: Page): Promise<Subject | null> {
    await visit(page, '/browse')
    return page.evaluate(async () => {
      const body = await (await fetch('/api/videos?limit=1')).json()
      const video = body.items?.[0]
      return video ? { id: video.id, slug: video.slug, title: video.title } : null
    })
  }

  async function setTrailer(page: Page, id: string, trailer: string): Promise<void> {
    await page.evaluate(
      async ({ id, trailer }) => {
        await fetch(`/api/videos/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trailerYoutubeId: trailer }),
        })
      },
      { id, trailer },
    )
  }

  /**
   * The ask this exists for: the button sits in the row with Play and My List,
   * and it opens a player rather than starting something behind the text.
   *
   * The `src` assertions are the real content of the test. A dialog holding an
   * iframe proves the markup; `mute=0` and `controls=1` prove it is the
   * *deliberate* player and not a second copy of the hero's decoration — which
   * is exactly what a careless reuse of the same embed URL would produce, and it
   * would look completely correct in a screenshot.
   */
  test('opens a player from the row beside My List', async ({ page }) => {
    const video = await aVideo(page)
    test.skip(video === null, 'the library holds no video')

    await setTrailer(page, video!.id, 'dQw4w9WgXcQ')

    try {
      await visit(page, `/v/${video!.slug}`)

      const trailer = page.getByRole('button', { name: /Watch the trailer/ })
      await expect(trailer).toBeVisible()

      // Beside My List, not adrift in a corner of the hero. Both are in the one
      // button row, which is the whole placement half of the change.
      const row = page.locator('main div', { has: trailer }).last()
      await expect(row.getByRole('button', { name: /my list/i })).toBeVisible()

      await trailer.click()

      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()

      const player = dialog.locator('iframe[src*="youtube"]')
      await expect(player).toHaveCount(1)
      await expect(player).toHaveAttribute('src', /mute=0/)
      await expect(player).toHaveAttribute('src', /controls=1/)

      /**
       * Closing must *unmount* it. A hidden iframe keeps playing, and a trailer
       * you can hear but cannot find is worse than one that will not start —
       * which is why the component `v-if`s the player rather than trusting the
       * dialog to hide it.
       */
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()

      /**
       * Scoped to the dialog, and reported by `src` rather than by count.
       *
       * The hero's ambient trailer is also a YouTube iframe on this page, so a
       * bare "expected 0 iframes" cannot say which one survived — and with
       * reduced motion off it would be the ambient one, correctly restarting now
       * that the dialog has stopped pausing it. Naming the `src` is what turns a
       * failure here into a sentence instead of a number.
       */
      await expect.poll(() => dialog.locator('iframe').evaluateAll(
        els => els.map(e => (e.getAttribute('src') ?? '').replace(/^.*\/embed\//, '')),
      )).toEqual([])
    }
    finally {
      await setTrailer(page, video!.id, '')
    }
  })

  /**
   * A button that opens an empty box is worse than no button, and most of a
   * library has no trailer — so this is the common case, not the edge one.
   */
  test('offers nothing when there is no trailer', async ({ page }) => {
    const video = await aVideo(page)
    test.skip(video === null, 'the library holds no video')

    await setTrailer(page, video!.id, '')
    await visit(page, `/v/${video!.slug}`)

    // Waited for rather than asserted straight away: an absence is true before
    // the page has rendered anything at all, so pin something real first.
    await expect(page.getByRole('button', { name: /my list/i })).toBeVisible()
    await expect(page.getByRole('button', { name: /Watch the trailer/ })).toHaveCount(0)
  })
})
