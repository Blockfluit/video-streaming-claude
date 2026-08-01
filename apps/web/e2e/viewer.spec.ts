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

/** The id of the video the player page is currently showing. */
async function currentVideoId(page: Page): Promise<string> {
  const [, collection, ...rest] = new URL(page.url()).pathname.split('/').filter(Boolean)
  const resolved = await page.evaluate(
    async ({ slug, path }) => {
      const response = await fetch(
        `/api/collections/${slug}/resolve?path=${encodeURIComponent(path)}`,
      )
      return (await response.json()).data.id as string
    },
    { slug: collection, path: rest.join('/') },
  )
  return resolved
}

/** The viewer-facing app: every control a member can press. */
test.describe('viewer', () => {

  /**
   * The hero resumes rather than explaining itself.
   *
   * Continue Watching and "Next episode" are the only places that go straight
   * into the player: someone mid-episode has already seen the overview, and
   * making them click twice to get back is friction. When nothing has been
   * watched the hero is the featured collection instead, which opens an
   * overview — so this accepts either and asserts on where it landed.
   */
  test('the hero button reaches a player or a collection overview', async ({ page }) => {
    await visit(page, '/')
    const hero = page.getByRole('link', { name: /^(Resume|Play)/ })
    await expect(hero).toBeVisible()

    const href = await hero.getAttribute('href') ?? ''
    await hero.click()
    await page.waitForURL(/\/c\//)

    if (href.includes('play=1')) {
      await expect(page.locator('video')).toBeVisible()
    } else {
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    }
  })

  /**
   * The change this step exists for: a card no longer starts playback. It
   * opens a page that says what the thing is, and Play is a second, deliberate
   * click.
   */
  test('a card opens the overview, and Play starts the video', async ({ page }) => {
    await visit(page, '/')
    const card = page.locator('main a[href^="/c/"]').first()
    const href = await card.getAttribute('href')

    await card.click()
    await page.waitForURL(url => url.pathname === href)

    // The overview, not the player.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.locator('video')).toHaveCount(0)

    await page.getByRole('link', { name: /^(Play|Resume)/ }).first().click()
    await page.waitForURL(/play=1/)
    await expect(page.locator('video')).toBeVisible()
  })

  /**
   * The trailer is created on mount, after a delay, and only when motion is
   * allowed. The iframe never loads — third-party media is stubbed in
   * `fixtures.ts` — so what is checked is that we asked for the right thing:
   * the nocookie host, muted, and looping with the `playlist` YouTube needs to
   * honour `loop` at all.
   */
  test('a trailer fades in over the hero when one is set', async ({ page }) => {
    const withTrailer = await page.evaluate(async () => {
      const response = await fetch('/api/collections?limit=100')
      const items = (await response.json()).items as { slug: string, trailerYoutubeId: string | null }[]
      return items.find(collection => collection.trailerYoutubeId)?.slug ?? null
    })
    // Decided from the data, never from a locator count — `count()` does not
    // retry, so a skip written that way runs before the page renders and is
    // therefore always true.
    test.skip(!withTrailer, 'no collection in this library has a trailer')

    await visit(page, `/c/${withTrailer}`)

    const frame = page.locator('iframe[src*="youtube-nocookie.com/embed/"]')
    await expect(frame).toBeVisible({ timeout: 15_000 })

    const src = await frame.getAttribute('src') ?? ''
    expect(src).toContain('mute=1')
    // `loop=1` alone plays once and stops; the playlist is what makes it loop.
    expect(src).toContain('loop=1')
    expect(src).toContain('playlist=')
  })

  /** The one accessibility rule the feature has, and it must not be advisory. */
  test('no trailer is created under prefers-reduced-motion', async ({ page }) => {
    const withTrailer = await page.evaluate(async () => {
      const response = await fetch('/api/collections?limit=100')
      const items = (await response.json()).items as { slug: string, trailerYoutubeId: string | null }[]
      return items.find(collection => collection.trailerYoutubeId)?.slug ?? null
    })
    test.skip(!withTrailer, 'no collection in this library has a trailer')

    await page.emulateMedia({ reducedMotion: 'reduce' })
    await visit(page, `/c/${withTrailer}`)

    // Comfortably past the 2s delay.
    await page.waitForTimeout(4000)
    await expect(page.locator('iframe[src*="youtube"]')).toHaveCount(0)
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
    /*
     * Two clicks now, not one. A card lands on the overview and Play opens the
     * player — without the second click every test in this block would look
     * for a `<video>` on a page that deliberately has none.
     */
    test.beforeEach(async ({ page }) => {
      await visit(page, '/')
      await page.locator('main a[href^="/c/"]').first().click()
      await page.waitForURL(/\/c\/.+/)
      await page.getByRole('link', { name: /^(Play|Resume)/ }).first().click()
      await page.waitForURL(/play=1/)
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
      // The marker goes on *this* video, resolved from the URL. Querying for
      // "the first video" instead makes the test depend on the two lookups
      // agreeing, which they stop doing the moment the library changes.
      const target = await currentVideoId(page)
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

    test('the my-list button saves and unsaves', async ({ page }) => {
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

    test('the sidebar moves between videos in the collection', async ({ page }) => {
      /**
       * The skip is decided from the *data*, not from the DOM.
       *
       * This guard used to be `await page.getByText('More from').count() === 0`,
       * run immediately after `waitForURL`. `count()` does not retry, and the
       * sidebar renders about 200ms after the route resolves — so it read 0
       * every single time and the test skipped on every run since it was
       * written, reporting "only one video in this collection" about a
       * collection holding five. A test that never runs is worse than no test:
       * it reports green.
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
      await expect(page.getByText('More from')).toBeVisible()

      const other = page.locator('aside a').nth(1)
      const href = await other.getAttribute('href')
      await other.click()
      await page.waitForURL(url => url.pathname === href)

      // The sidebar links to overviews now, like every other card in the app —
      // only Continue Watching and "Next episode" go straight into the player.
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      await expect(page.getByRole('link', { name: /^(Play|Resume)/ }).first()).toBeVisible()
    })
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
