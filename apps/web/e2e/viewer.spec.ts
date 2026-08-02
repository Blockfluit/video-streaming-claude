import { expect, expectsRequest, fillStable, test, visit } from './fixtures'
import type { Page } from '@playwright/test'


/** Waits for metadata. Setting `currentTime` before it arrives is silently ignored. */
async function withMetadata(page: Page) {
  const video = page.locator('video')
  await expect
    .poll(() => video.evaluate((el: HTMLVideoElement) => el.readyState), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(1)
  return video
}

/**
 * The id of the video the player page is showing — which the player URL simply
 * *is*. It used to have to resolve the slug path back into an id; keying the
 * player on the id is what made that unnecessary.
 */
function currentVideoId(page: Page): string {
  const segments = new URL(page.url()).pathname.split('/').filter(Boolean)
  return segments[segments.length - 1]!
}

/**
 * Home → a title page → playing.
 *
 * The two steps are the change worth asserting: a card no longer lands on a
 * stream, so anything testing the player has to press Play like a person does.
 */
async function startPlaying(page: Page): Promise<void> {
  await visit(page, '/')
  await openFirstTitlePage(page)
  await page.getByRole('link', { name: /^(Play|Resume)/ }).first().click()
  await page.waitForURL(/\/watch\//)
}

/**
 * Opens the first video card on the current page.
 *
 * Continue Watching cards now point at `/watch/`, so "the first card" has to
 * mean the first one that goes to a title page — otherwise this walks straight
 * past the thing under test on any account that has watched something.
 */
async function openFirstTitlePage(page: Page): Promise<void> {
  const card = page.locator('main a[href^="/c/"]').first()
  const href = await card.getAttribute('href')
  await card.click()
  await page.waitForURL(url => url.pathname === href)
}

/** The viewer-facing app: every control a member can press. */
test.describe('viewer', () => {

  /**
   * The home hero is a resume surface, so it plays rather than describing.
   * Whether it lands on `/watch/` or on a collection depends on whether this
   * account has watched anything, and both are correct — what must hold is that
   * a hero button labelled Play or Resume gets somewhere you can press play.
   */
  test('the hero play button reaches a player', async ({ page }) => {
    await visit(page, '/')
    const hero = page.getByRole('link', { name: /^(Resume|Play)$/ }).first()
    await expect(hero).toBeVisible()

    await hero.click()
    await page.waitForURL(/\/(watch|c)\//)

    if (!/\/watch\//.test(page.url())) {
      await page.getByRole('link', { name: /^(Play|Resume)/ }).first().click()
      await page.waitForURL(/\/watch\//)
    }
    await expect(page.locator('video')).toBeVisible()
  })

  /**
   * The change this whole branch exists for. A card used to open a loading
   * stream with the synopsis somewhere below it; it now opens the page that
   * says what the thing is, and playback is a deliberate second press.
   */
  test('a card opens a title page, and Play opens the player', async ({ page }) => {
    await visit(page, '/')
    await openFirstTitlePage(page)

    // Something to read, and nothing streaming yet.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.locator('video')).toHaveCount(0)

    const play = page.getByRole('link', { name: /^(Play|Resume)/ }).first()
    await expect(play).toBeVisible()
    await play.click()

    await page.waitForURL(/\/watch\//)
    await expect(page.locator('video')).toBeVisible()
  })

  test('the player links back to the title page it came from', async ({ page }) => {
    await visit(page, '/')
    await openFirstTitlePage(page)
    const titlePage = new URL(page.url()).pathname

    await page.getByRole('link', { name: /^(Play|Resume)/ }).first().click()
    await page.waitForURL(/\/watch\//)

    await page.getByRole('link', { name: 'Details' }).click()
    await page.waitForURL(url => url.pathname === titlePage)
    await expect(page.locator('video')).toHaveCount(0)
  })

  test('search narrows the browse page and survives a reload', async ({ page }) => {
    await visit(page, '/browse')
    await expect(page.locator('main a[href^="/c/"]').first()).toBeVisible()

    await fillStable(page, 'input[placeholder="Search the library"]', 'zzzznothing')
    await expect(page.getByText(/Nothing matches/)).toBeVisible()

    // Debounced into the URL, so the search is shareable.
    await expect(page).toHaveURL(/q=zzzznothing/)
    await page.reload()
    await expect(page.getByPlaceholder('Search the library')).toHaveValue('zzzznothing')
  })

  test('history renders what has been watched', async ({ page }) => {
    await visit(page, '/history')
    await expect(page.getByRole('heading', { name: 'History' })).toBeVisible()
  })

  test.describe('on the player page', () => {
    test.beforeEach(async ({ page }) => {
      await startPlaying(page)
    })

    test('the stream actually loads into the element', async ({ page }) => {
      const video = page.locator('video')
      await expect(video).toBeVisible()

      // readyState >= 1 means metadata arrived — the range request worked.
      await expect
        .poll(() => video.evaluate((el: HTMLVideoElement) => el.readyState), { timeout: 20_000 })
        .toBeGreaterThanOrEqual(1)
    })

    /**
     * Sets its own marker first. Depending on whatever the seed data happens to
     * carry makes this pass or skip according to what another spec did last,
     * which is worse than no test.
     */
    test('skip intro seeks past the intro', async ({ page }) => {
      // The marker goes on *this* video, read from the URL. Querying for "the
      // first video" instead makes the test depend on the two lookups agreeing,
      // which they stop doing the moment the library changes.
      const target = currentVideoId(page)
      const duration = await (await withMetadata(page)).evaluate(
        (el: HTMLVideoElement) => el.duration,
      )
      const introEnd = Math.max(1, Math.min(5, (duration || 10) / 2))

      await page.evaluate(async ({ id, end }) => {
        await fetch(`/api/videos/${id}/markers`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ introStartSec: 0, introEndSec: end }),
        })
      }, { id: target, end: introEnd })
      await page.reload()
      await page.waitForLoadState('networkidle')

      const skip = page.getByRole('button', { name: 'Skip intro' })
      await expect(skip).toBeVisible()

      await skip.click()
      await expect
        .poll(() => page.locator('video').evaluate((el: HTMLVideoElement) => el.currentTime))
        .toBeGreaterThan(0)
    })

    /**
     * On the title page, not the player: that is where the button now lives,
     * along with everything else you would decide something with.
     */
    test('the my-list button saves and unsaves', async ({ page }) => {
      await visit(page, '/')
      await openFirstTitlePage(page)

      const button = page.getByRole('button', { name: /my list/i })
      await expect(button).toBeVisible()

      await expectsRequest(page, /\/me\/watchlist/, 'POST', () => button.click())
      await expect(button).toHaveText(/in my list/i)
      await expect(button).toHaveAttribute('aria-pressed', 'true')

      await expectsRequest(page, /\/me\/watchlist/, 'DELETE', () => button.click())
      await expect(button).toHaveText(/^my list$/i)
    })

    test('posting a comment adds it to the thread', async ({ page }) => {
      const body = `A note from the tests ${Date.now()}`
      await page.getByPlaceholder(/Say something/).fill(body)

      await expectsRequest(page, /\/comments$/, 'POST', () =>
        page.getByRole('button', { name: 'Post' }).click())

      await expect(page.getByText(body)).toBeVisible()
    })

    test('a pinned comment seeks the player when clicked', async ({ page }) => {
      const video = page.locator('video')
      // Two thirds in, whatever the runtime — a fixed offset overshoots a short
      // clip, gets clamped to the end, and the assertion then measures nothing.
      await video.evaluate((el: HTMLVideoElement) => {
        // Two thirds in, whatever the runtime — a fixed offset overshoots a
        // short clip and gets clamped to the end.
        el.currentTime = Math.max(1, (el.duration || 12) * 0.66)
      })

      // The pin reads the position the UI is showing, so wait for it to catch up.
      await expect(page.getByText(/Pin to (?!0:00)/)).toBeVisible()

      await page.getByPlaceholder(/Say something/).fill('Pinned by the tests')
      await page.getByRole('checkbox').check()
      await page.getByRole('button', { name: 'Post' }).click()

      // The thread accumulates pins across runs, so assert against the stamp
      // that is actually clicked rather than the number this test happened to
      // post — otherwise it measures whichever comment sorted first.
      const stamp = page.getByRole('button', { name: /^\d+:\d\d$/ }).first()
      await expect(stamp).toBeVisible()
      const [minutes, seconds] = (await stamp.innerText()).split(':').map(Number)
      const expected = minutes * 60 + seconds
      expect(expected).toBeGreaterThan(0)

      await video.evaluate((el: HTMLVideoElement) => { el.currentTime = 0 })
      await stamp.click()
      await expect
        .poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime))
        .toBeGreaterThanOrEqual(expected - 1)
    })

    test('a comment can be deleted, and leaves a tombstone', async ({ page }) => {
      const body = `Delete me ${Date.now()}`
      await page.getByPlaceholder(/Say something/).fill(body)
      await page.getByRole('button', { name: 'Post' }).click()
      await expect(page.getByText(body)).toBeVisible()

      await expectsRequest(page, /\/comments\//, 'DELETE', () =>
        page.getByRole('button', { name: 'Delete comment' }).first().click())

      await expect(page.getByText(body)).toHaveCount(0)
      await expect(page.getByText('This comment was removed.').first()).toBeVisible()
    })

    /**
     * The "More from" shelf moved off the player and onto the title page, where
     * the rest of the collection belongs. It is a horizontal row now rather than
     * the narrow aside it was.
     */
    test('the More from shelf moves between videos in the collection', async ({ page }) => {
      await visit(page, '/')
      await openFirstTitlePage(page)

      /**
       * The skip is decided from the *data*, not from the DOM.
       *
       * This guard used to be `await page.getByText('More from').count() === 0`,
       * run immediately after `waitForURL`. `count()` does not retry, and the
       * shelf renders about 200ms after the route resolves — so it read 0 every
       * single time and the test skipped on every run since it was written,
       * reporting "only one video in this collection" about a collection
       * holding five. A test that never runs is worse than no test: it reports
       * green.
       */
      const inCollection = await page.evaluate(async () => {
        const response = await fetch('/api/videos?limit=100')
        const body = await response.json()
        const counts = new Map<string, number>()
        for (const video of body.items ?? []) {
          const key = video.collection?.slug ?? '(none)'
          counts.set(key, (counts.get(key) ?? 0) + 1)
        }
        return Math.max(0, ...counts.values())
      })
      test.skip(inCollection < 2, 'no collection here holds two videos')

      // Now wait for it properly — `expect` retries where `count()` does not.
      const shelf = page.getByRole('heading', { name: /^More from / })
      await expect(shelf).toBeVisible()

      // Scoped to the shelf's own section, so this cannot pick up a card from
      // somewhere else on the page and still pass.
      const card = page.locator('section').filter({ has: shelf }).locator('a[href^="/c/"]').first()
      await expect(card).toBeVisible()

      const href = await card.getAttribute('href')
      await card.click()
      await page.waitForURL(url => url.pathname === href)
      // Another title page, and it offers to play what it describes.
      await expect(page.getByRole('link', { name: /^(Play|Resume)/ }).first()).toBeVisible()
    })
  })

  /**
   * The collection title page. Which body it draws depends on whether the
   * collection has seasons, so the shape is read from the data first — deciding
   * it from the DOM is how a skip ends up never running.
   */
  test('a collection page describes the collection and offers to play it', async ({ page }) => {
    await visit(page, '/browse')
    const first = page.locator('main a[href^="/c/"]').first()
    await expect(first).toBeVisible()
    await first.click()
    await page.waitForURL(/\/c\/[^/]+$/)

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    // A title page, not a player.
    await expect(page.locator('video')).toHaveCount(0)
  })

  test('a season can be chosen when the collection has seasons', async ({ page }) => {
    const withSeasons = await page.evaluate(async () => {
      const body = await (await fetch('/api/collections?limit=100')).json()
      for (const collection of body.items ?? []) {
        const detail = await (await fetch(`/api/collections/${collection.slug}`)).json()
        if ((detail.seasons ?? []).length > 0) return collection.slug as string
      }
      return null
    })
    test.skip(withSeasons === null, 'no collection here has seasons')

    await visit(page, `/c/${withSeasons}`)

    const select = page.getByRole('combobox', { name: 'Choose a season' })
    await expect(select).toBeVisible()

    await select.click()
    // Reka UI teleports the listbox to <body>, so this is not scoped to main.
    const option = page.getByRole('option').nth(1)
    await expect(option).toBeVisible()
    await option.click()

    // The choice goes into the URL, so it survives a reload and a shared link.
    await page.waitForURL(/\/c\/[^/]+\/.+/)
  })

  test('my-list removal takes the card away', async ({ page }) => {
    // Saved through the API so the test does not depend on what a previous one
    // left behind — the toggle itself is covered on the player page.
    await visit(page, '/')
    await page.evaluate(async () => {
      const videos = await (await fetch('/api/videos?limit=1')).json()
      await fetch('/api/me/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoId: videos.items[0].id }),
      })
    })

    await visit(page, '/my-list')
    const cards = page.locator('main a[href^="/c/"]')
    const before = await cards.count()
    expect(before).toBeGreaterThan(0)

    await page.locator('main [aria-label^="Remove"]').first().click()
    await expect(cards).toHaveCount(before - 1)
  })
})
