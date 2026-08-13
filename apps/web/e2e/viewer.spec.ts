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
 * The id of the video the player is showing, from the slug in the URL.
 *
 * A video addresses itself now, so this is one lookup rather than resolving a
 * collection path back into a video.
 */
async function currentVideoId(page: Page): Promise<string> {
  const segments = new URL(page.url()).pathname.split('/').filter(Boolean)
  const slug = segments[segments.length - 1]!
  return page.evaluate(
    async (s) => (await (await fetch(`/api/videos/by-slug/${s}`)).json()).id as string,
    slug,
  )
}

/** A video's own page, chosen from the data rather than from whatever is first. */
async function aVideoPage(page: Page): Promise<string> {
  await visit(page, '/browse')
  const slug = await page.evaluate(async () => {
    const body = await (await fetch('/api/videos?limit=1')).json()
    return (body.items?.[0]?.slug ?? null) as string | null
  })
  expect(slug, 'the library holds no video').not.toBeNull()
  return `/v/${slug}`
}

/** A video page, then Play — playback is a deliberate second press now. */
async function startPlaying(page: Page): Promise<void> {
  await visit(page, await aVideoPage(page))
  await page.getByRole('link', { name: /^(Play|Resume)/ }).first().click()
  await page.waitForURL(/\/watch\//)
}

/** The viewer-facing app: every control a member can press. */
test.describe('viewer', () => {

  /**
   * The home hero is a resume surface, so it plays. Where it lands depends on
   * whether this account has watched anything — both are correct; what must
   * hold is that it gets somewhere you can press play.
   */
  test('the hero play button reaches a player', async ({ page }) => {
    await visit(page, '/')
    const hero = page.getByRole('link', { name: /^(Resume|Play)$/ }).first()
    await expect(hero).toBeVisible()

    await hero.click()
    await page.waitForURL(/\/(watch|v|c)\//)

    if (!/\/watch\//.test(page.url())) {
      await page.getByRole('link', { name: /^(Play|Resume)/ }).first().click()
      await page.waitForURL(/\/watch\//)
    }
    await expect(page.locator('video')).toBeVisible()
  })

  /**
   * The change this branch exists for. A card used to open a loading stream
   * with the synopsis somewhere below it; it now opens the page that says what
   * the thing is, and playback is a deliberate second press.
   */
  test('a card opens a page describing the video, and Play opens the player', async ({ page }) => {
    await visit(page, await aVideoPage(page))

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.locator('video')).toHaveCount(0)

    const play = page.getByRole('link', { name: /^(Play|Resume)/ }).first()
    await expect(play).toBeVisible()
    await play.click()

    await page.waitForURL(/\/watch\//)
    await expect(page.locator('video')).toBeVisible()
  })

  test('the player links back to the page it came from', async ({ page }) => {
    const videoPage = await aVideoPage(page)
    await visit(page, videoPage)

    await page.getByRole('link', { name: /^(Play|Resume)/ }).first().click()
    await page.waitForURL(/\/watch\//)

    await page.getByRole('link', { name: 'Details' }).click()
    await page.waitForURL(url => url.pathname === videoPage)
    await expect(page.getByRole('link', { name: /^(Play|Resume)/ }).first()).toBeVisible()
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

  /**
   * Browse lists a shelf and the films on it side by side, so a card has to say
   * which it is. The chip is the whole of that answer.
   *
   * The film half is decided from the **data**, never from `locator.count()`:
   * a count guard runs before the client-side route has rendered and is
   * therefore always true, which is how a skip reports green for months. The
   * fetch also drives `?film=true` through the proxy end to end, so a rename
   * that missed the API would fail here rather than quietly find nothing.
   */
  test('browse says which cards are shelves and which are films', async ({ page }) => {
    await visit(page, '/browse')

    const shelf = page.locator('main a[href^="/c/"]').first()
    await expect(shelf).toBeVisible()
    await expect(shelf.getByText(/\d+ (season|film)s?|Collection/)).toBeVisible()

    const films = await page.evaluate(async () => {
      const response = await fetch('/api/videos?film=true&limit=1')
      return response.ok ? ((await response.json()).items ?? []).length : 0
    })

    if (films > 0) {
      const film = page.locator('main a[href^="/v/"]').first()
      await expect(film).toBeVisible()
      // A film is the ordinary case, and says so by carrying no chip.
      await expect(film.getByText(/\d+ (season|film)s?/)).toHaveCount(0)
    }
  })

  test('history renders what has been watched', async ({ page }) => {
    await visit(page, '/history')
    await expect(page.getByRole('heading', { name: 'History' })).toBeVisible()
  })

  /**
   * The button that says Resume resumes.
   *
   * Driven from `/v/:slug` rather than by reloading the player, and that is not
   * a stylistic choice: the player fires a closing beat on `pagehide`, so a
   * reload from a player parked at 0:00 writes that 0:00 over the progress this
   * test just seeded, and the assertion then measures the teardown instead of
   * the feature. The description page carries no player, so nothing overwrites
   * anything — and pressing Play there is the journey being claimed anyway.
   */
  test('pressing Resume opens where it was left, and the offer returns to the start',
    async ({ page }) => {
      const path = await aVideoPage(page)
      const slug = path.split('/').pop()!
      const detail = await page.evaluate(
        async (s) => (await (await fetch(`/api/videos/by-slug/${s}`)).json()) as {
          id: string
          durationSec: number | null
        },
        slug,
      )

      // A third of the way in, whatever the runtime. A fixed offset lands past
      // the 95% mark on a short clip, where starting over is the correct answer
      // — so the test would be asserting the opposite of what it means to.
      const duration = detail.durationSec ?? 0
      const seeded = Math.max(6, duration / 3)
      // Decided from the data, not from the DOM: a clip too short to hold a
      // resume point at all has nothing to say about resuming.
      test.skip(
        !(duration > 0) || seeded >= duration * 0.95,
        `the sample clip runs ${duration}s, too short to hold a resume point`,
      )

      await page.evaluate(
        async ({ id, positionSec }) => {
          await fetch(`/api/videos/${id}/heartbeat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              playSessionId: crypto.randomUUID(),
              positionSec,
              deltaSec: 1,
            }),
          })
        },
        { id: detail.id, positionSec: seeded },
      )

      await visit(page, path)
      await page.getByRole('link', { name: /^Resume from/ }).click()
      await page.waitForURL(/\/watch\//)
      await withMetadata(page)

      const currentTime = () =>
        page.locator('video').evaluate((el: HTMLVideoElement) => el.currentTime)

      // The whole change, in one assertion.
      await expect.poll(currentTime).toBeGreaterThan(seeded - 2)

      /*
       * And again on a hard load, which is a different path and was a real bug.
       *
       * Arriving by clicking a link, the player is created client-side and
       * cannot miss `loadedmetadata`. Arriving by loading the URL, the `<video>`
       * is in the server-rendered markup and the browser starts fetching before
       * Vue hydrates — so the event fires into nothing and the resume was
       * silently skipped. Reloading here is the only assertion that can tell.
       *
       * It goes *before* the offer is pressed, not after: pressing it seeks to
       * zero, and the closing beat this reload fires would write that zero over
       * the progress the test seeded, leaving nothing to resume to.
       */
      await page.reload()
      await withMetadata(page)
      await expect.poll(currentTime).toBeGreaterThan(seeded - 2)

      /*
       * Hover first, and not for the sake of it: the offer now stands for seven
       * wall-clock seconds whether or not anything is playing, so a slow machine
       * could lose the race to the assertions below. Hovering pauses the sweep
       * that times it — which freezes the offer for the rest of the test and
       * covers that pause behaviour at the same time.
       */
      const startOver = page.getByRole('button', { name: 'Start from the beginning' })
      await startOver.hover()
      await expect(startOver).toBeVisible()

      await startOver.click()
      await expect.poll(currentTime).toBeLessThan(1)
      await expect(startOver).toBeHidden()
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
      // The marker goes on *this* video, resolved from the URL. Querying for
      // "the first video" instead makes the test depend on the two lookups
      // agreeing, which they stop doing the moment the library changes.
      const target = await currentVideoId(page)
      const video = await withMetadata(page)
      const duration = await video.evaluate((el: HTMLVideoElement) => el.duration)

      /*
       * The intro has to contain wherever playback *opens*, which is no longer
       * always 0:00 — the player resumes, so an account that has watched this
       * video before lands past a 0-5s intro and the button correctly never
       * appears. Anchoring the range to the current position keeps the test
       * about the intro rather than about whatever the previous spec watched.
       */
      const opensAt = await video.evaluate((el: HTMLVideoElement) => el.currentTime)
      const introEnd = Math.min(duration - 1, opensAt + Math.max(1, Math.min(5, (duration || 10) / 2)))

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
      // Against the intro's end, not against zero: playback can already be past
      // zero on arrival now, so `> 0` would pass without the button doing
      // anything at all.
      await expect
        .poll(() => page.locator('video').evaluate((el: HTMLVideoElement) => el.currentTime))
        .toBeGreaterThanOrEqual(introEnd - 1)
    })

    /**
     * On the video's own page, not the player: that is where the button now
     * lives, with everything else you would decide something with.
     */
    test('the my-list button saves and unsaves', async ({ page }) => {
      await visit(page, await aVideoPage(page))

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
     * The "More from" shelf moved off the player and onto the video's own page,
     * where the rest of the collection belongs. It is a horizontal row now
     * rather than the narrow aside it was.
     */
    test('the More from shelf moves between videos in the collection', async ({ page }) => {
      /**
       * The skip is decided from the *data*, and the page it opens is chosen
       * from that same data.
       *
       * This guard used to be `await page.getByText('More from').count() === 0`
       * run straight after `waitForURL`. `count()` does not retry and the shelf
       * renders after the route resolves, so it read 0 every time and the test
       * skipped on every run since it was written. It then silently kept
       * skipping for a second reason: it read `video.collection?.slug`, and a
       * video carries `collections[]` — a list — so the key was always
       * `(none)`. A test that never runs reports green, which is worse than no
       * test at all.
       */
      await visit(page, '/browse')
      const target = await page.evaluate(async () => {
        const list = await (await fetch('/api/collections?limit=100')).json()
        for (const collection of list.items ?? []) {
          const detail = await (await fetch(`/api/collections/${collection.slug}`)).json()
          const videos = detail.videos ?? []
          if (videos.length > 1) return `/v/${videos[0].slug}`
        }
        return null
      })
      test.skip(target === null, 'no collection here holds two videos')

      await visit(page, target!)

      // Now wait for it properly — `expect` retries where `count()` does not.
      const shelf = page.getByRole('heading', { name: /^More from / })
      await expect(shelf).toBeVisible()

      // Scoped to the shelf's own section, so it cannot pick up a card from
      // elsewhere on the page and still pass.
      const card = page.locator('section').filter({ has: shelf }).locator('a[href^="/watch/"]').first()
      await expect(card).toBeVisible()

      const href = await card.getAttribute('href')
      await card.click()
      await page.waitForURL(url => url.pathname === href)

      /*
       * Straight into playback, not onto another page of description. The shelf
       * only appears when this video is in a collection, so choosing from it is
       * the same act as choosing an episode on the collection's own page — and
       * that plays. This asserted a `Play` link here while the cards went to
       * `/v/`; both halves changed together.
       */
      await expect(page.locator('video')).toBeVisible()
    })
  })

  /**
   * The collection title page: hero, season selector, episode rows.
   */
  test('a collection page describes the collection and offers to play it', async ({ page }) => {
    await visit(page, '/browse')
    const collection = page.locator('main a[href^="/c/"]').first()
    await expect(collection).toBeVisible()
    const href = await collection.getAttribute('href')
    await collection.click()
    await page.waitForURL(url => url.pathname === href)

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    // A page describing it, not a player.
    await expect(page.locator('video')).toHaveCount(0)
  })

  /**
   * What a collection page is for: you opened the show and picked the episode,
   * and that *is* the decision — so it plays, rather than handing you a second
   * page describing the thing you just chose.
   *
   * One test covers both shapes. A collection with seasons draws `EpisodeRow`s
   * and one without draws a grid of `MediaCard`s, and after this change every
   * entry in either is a link to `/watch/`.
   */
  test('picking a video inside a collection plays it', async ({ page }) => {
    // Somewhere in the app first: a relative fetch inside page.evaluate has no
    // base URL to resolve against on about:blank.
    await visit(page, '/browse')

    // Decided from the data, never from `locator.count()` — that does not retry,
    // so a guard written with it runs before the list renders and skips every
    // time, which is how the sidebar test reported green for weeks while
    // testing nothing. A collection showing a *list* is what is needed: a lone
    // film in a collection is just the hero.
    const slug = await page.evaluate(async () => {
      const list = await (await fetch('/api/collections?limit=100')).json()
      for (const collection of list.items ?? []) {
        const detail = await (await fetch(`/api/collections/${collection.slug}`)).json()
        const listed = (detail.videos ?? []).length > 1 || (detail.seasons ?? []).length > 0
        if (listed && (detail.videos ?? []).length > 0) return collection.slug as string
      }
      return null
    })
    test.skip(slug === null, 'no collection here lists more than one video')

    await visit(page, `/c/${slug}`)

    /*
     * Scoped past the hero. Its Play button is also a `/watch/` link, so an
     * unscoped `.first()` would click that and pass without ever touching an
     * episode row — the thing under test. The hero is the `<section>`; the list
     * is in the `<div>` that follows it.
     */
    const entry = page.locator('main section ~ div a[href^="/watch/"]').first()
    await expect(entry).toBeVisible()

    const href = await entry.getAttribute('href')
    await entry.click()
    await page.waitForURL(url => url.pathname === href)
    await expect(page.locator('video')).toBeVisible()
  })

  /**
   * Cards show posters; episode rows show banners.
   *
   * Asserted through the *request* rather than the rendered box, because the
   * wrong shape in the right aspect box is exactly the bug that hides: a 16:9
   * still cropped into a 2:3 tile still fills it, and looks merely badly framed.
   * `MediaCard` carried a `shape` prop no caller ever passed for months, which
   * is what that failure looks like from the outside.
   */
  test('cards ask for posters and episode rows ask for banners', async ({ page }) => {
    const asked: string[] = []
    page.on('request', (request) => {
      const match = /\/api\/(videos|collections)\/[^/]+\/(poster|banner)/.exec(request.url())
      if (match) asked.push(match[2]!)
    })

    await visit(page, '/browse')
    await expect(page.locator('main a[href^="/c/"], main a[href^="/v/"]').first()).toBeVisible()
    await page.waitForTimeout(1000)

    expect(asked.filter(shape => shape === 'poster').length).toBeGreaterThan(0)

    const slug = await page.evaluate(async () => {
      const list = await (await fetch('/api/collections?limit=100')).json()
      for (const collection of list.items ?? []) {
        const detail = await (await fetch(`/api/collections/${collection.slug}`)).json()
        if ((detail.seasons ?? []).length > 0 && (detail.videos ?? []).length > 0) {
          return collection.slug as string
        }
      }
      return null
    })
    test.skip(slug === null, 'no collection here has seasons')

    asked.length = 0
    await visit(page, `/c/${slug}`)
    await expect(page.locator('main section ~ div a[href^="/watch/"]').first()).toBeVisible()
    await page.waitForTimeout(1000)

    // The episode rows are the one place banners are the point.
    expect(asked.filter(shape => shape === 'banner').length).toBeGreaterThan(0)
  })

  /**
   * Hover must not cover the artwork.
   *
   * There was a circular play/info glyph in the middle of every tile, over the
   * one thing a card exists to show. It is a border now — and this checks the
   * overlay is *gone* rather than merely transparent, because `visible.spec.ts`
   * fails a control that is `opacity: 0` and still focusable.
   */
  test('hovering a card does not put anything over the picture', async ({ page }) => {
    await visit(page, '/browse')
    const card = page.locator('main a[href^="/c/"], main a[href^="/v/"]').first()
    await expect(card).toBeVisible()

    await card.hover()
    await expect(card.locator('.i-lucide-info, .i-lucide-play')).toHaveCount(0)
  })

  test('a season can be chosen when the collection has seasons', async ({ page }) => {
    // Somewhere in the app first: a relative fetch inside page.evaluate has no
    // base URL to resolve against on about:blank.
    await visit(page, '/browse')
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
    // Both shapes: a saved video links to its own page, a saved collection to
    // the collection. Counting only one silently measured nothing.
    const cards = page.locator('main a[href^="/c/"], main a[href^="/v/"]')
    const before = await cards.count()
    expect(before).toBeGreaterThan(0)

    await page.locator('main [aria-label^="Remove"]').first().click()
    await expect(cards).toHaveCount(before - 1)
  })
})
