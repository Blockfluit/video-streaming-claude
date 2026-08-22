import { expect, expectsRequest, fillStable, openBrowseFilters, test, visit, visitPlayer } from './fixtures'
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
 * Holds the playhead still.
 *
 * The player starts on its own, so a test about *where a seek lands* is
 * otherwise racing playback: by the time an assertion reads `currentTime`, the
 * film has moved on and the number says as much about the machine's speed as
 * about the button that was pressed.
 *
 * The listener matters as much as the `pause()`. Playing is attempted from
 * `loadedmetadata`, and that attempt is a promise that can settle *after* this
 * call — a bare `pause()` would then be undone a moment later, which is the
 * flake this exists to remove rather than a fix for it.
 */
async function freeze(page: Page): Promise<void> {
  await page.locator('video').evaluate((el: HTMLVideoElement) => {
    el.addEventListener('play', () => el.pause())
    el.pause()
  })
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

interface Membership {
  seasonId: string | null
  collection: { slug: string }
}

interface Candidate {
  slug: string
  collections?: Membership[] | null
}

/**
 * The library's videos with their memberships.
 *
 * `/api/videos` already carries `collections`, so the kind of a video is one
 * request away — which is what lets a test pick the kind it is about instead of
 * whatever sorts first.
 *
 * Asked through `page.request`, which carries the context's session cookie, so
 * no page has to be loaded to ask a question about the data. Routing it through
 * a `/browse` visit and an in-page `fetch` is what the older helper does, and it
 * makes every such lookup wait on `networkidle` for a page the test does not
 * care about — a shelf that keeps loading as it scrolls may never go idle.
 */
async function libraryVideos(page: Page): Promise<Candidate[]> {
  const response = await page.request.get('/api/videos?limit=100')
  expect(response.ok(), 'the library did not answer').toBeTruthy()
  return ((await response.json()).items ?? []) as Candidate[]
}

/** The membership that makes a video an episode, or null for everything else. */
function episodeOf(video: Candidate): Membership | null {
  return video.collections?.find(membership => membership.seasonId) ?? null
}

/**
 * A video that is **not** an episode.
 *
 * Details leads somewhere different for the two now, so a test about either has
 * to say which one it means. Taking whatever sorted first would leave this test
 * passing or failing on the seed data, and failing on *correct* behaviour the
 * day a series happens to sort to the front.
 */
async function aFilmPage(page: Page): Promise<string | null> {
  const film = (await libraryVideos(page)).find(video => !episodeOf(video))
  return film ? `/v/${film.slug}` : null
}

/** An episode, with the series its Details button must reach. */
async function anEpisode(page: Page): Promise<{ path: string, series: string } | null> {
  for (const video of await libraryVideos(page)) {
    const membership = episodeOf(video)
    if (membership) return { path: `/v/${video.slug}`, series: `/c/${membership.collection.slug}` }
  }
  return null
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
   * The home hero features something recently added, so it *describes* — a new
   * arrival is something you are still deciding about. It lands on a title page
   * or a collection page depending on what arrived last; both are correct, and
   * what must hold is that a player is one press away from either.
   *
   * It used to be a resume surface offering Play, which is why this looks for
   * "More info" now rather than a relaxed version of the old regex: a locator
   * loose enough to match both would have passed against a hero that had
   * stopped working.
   */
  test('the hero reaches a title page, and a player from there', async ({ page }) => {
    await visit(page, '/')
    const hero = page.getByRole('link', { name: 'More info' }).first()
    await expect(hero).toBeVisible()

    await hero.click()
    await page.waitForURL(/\/(v|c)\//)

    await page.getByRole('link', { name: /^(Play|Resume)/ }).first().click()
    await page.waitForURL(/\/watch\//)
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

  /**
   * A film's own page holds its synopsis, cast and certification, and no
   * collection page repeats any of it — so Details keeps leading there. The
   * video is chosen for *not* being an episode: those go somewhere else now,
   * and a test taking whatever sorted first would assert the wrong half of the
   * rule at the seed data's discretion.
   */
  test('the player links back to the film it came from', async ({ page }) => {
    const videoPage = await aFilmPage(page)
    // Decided from the data, not from a locator: a count that has not rendered
    // yet is zero, and a skip that always runs reports green forever.
    test.skip(videoPage === null, 'the library holds no video outside a season')
    await visit(page, videoPage!)

    await page.getByRole('link', { name: /^(Play|Resume)/ }).first().click()
    await page.waitForURL(/\/watch\//)

    await page.getByRole('link', { name: 'Details' }).click()
    await page.waitForURL(url => url.pathname === videoPage)
    await expect(page.getByRole('link', { name: /^(Play|Resume)/ }).first()).toBeVisible()
    await expect(page.locator('video')).toHaveCount(0)
  })

  /**
   * The change this exists for. Halfway through an episode, the page worth
   * reaching is the **show** — its seasons and the rest of its episodes — not a
   * page describing the episode already on screen.
   */
  test('the player sends an episode to its series', async ({ page }) => {
    const episode = await anEpisode(page)
    test.skip(episode === null, 'the library holds no episode in a season')

    await visit(page, episode!.path)
    await page.getByRole('link', { name: /^(Play|Resume)/ }).first().click()
    await page.waitForURL(/\/watch\//)

    await page.getByRole('link', { name: 'Details' }).click()
    await page.waitForURL(url => url.pathname === episode!.series)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await expect(page.locator('video')).toHaveCount(0)
  })

  /**
   * Arriving at the player is the press that starts it.
   *
   * `paused` alone would pass against a player that is stalled rather than
   * playing — the flag says what was *asked for*, not what is happening — so
   * the position has to move as well. Both, or this passes while the picture
   * sits still.
   */
  test('the player starts playing on arrival', async ({ page }) => {
    await startPlaying(page)
    const video = await withMetadata(page)

    await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.paused)).toBe(false)

    const at = () => video.evaluate((el: HTMLVideoElement) => el.currentTime)
    const opened = await at()
    await expect.poll(at).toBeGreaterThan(opened)
  })

  /**
   * And on a hard load, which is a different path and where the *resume* was
   * once silently skipped: the `<video>` arrives in the server-rendered markup
   * and the browser starts fetching before Vue hydrates, so `loadedmetadata`
   * can fire into nothing. Playing is started from that same handler, so it can
   * be lost the same way and only a real page load can tell.
   */
  test('the player starts playing on a hard load of its URL', async ({ page }) => {
    await startPlaying(page)
    const url = new URL(page.url()).pathname

    // `visitPlayer`, not `visit`: a page that is streaming never reaches
    // `networkidle`, so the ordinary helper waits here until the test dies.
    await visitPlayer(page, url)
    const video = await withMetadata(page)

    await expect.poll(() => video.evaluate((el: HTMLVideoElement) => el.paused)).toBe(false)
  })

  const SEARCH = 'input[placeholder="Search titles, genres and cast"]'

  test('search narrows the browse page and survives a reload', async ({ page }) => {
    await visit(page, '/browse')
    await expect(page.locator('main a[href^="/c/"]').first()).toBeVisible()

    await fillStable(page, SEARCH, 'zzzznothing')
    await expect(page.getByText(/Nothing matches/)).toBeVisible()

    // Debounced into the URL, so the search is shareable.
    await expect(page).toHaveURL(/q=zzzznothing/)
    await page.reload()
    await expect(page.getByPlaceholder('Search titles, genres and cast')).toHaveValue('zzzznothing')
  })

  /**
   * The type filter partitions the grid rather than hiding half of it.
   *
   * Asserted through `expectsRequest`, because a select that renders perfectly
   * and reaches no endpoint looks identical from the outside — and the whole
   * point of moving the merge onto the server is that this one request is what
   * decides the page.
   */
  /**
   * The filters are one press away on a desktop too, not only on a phone.
   *
   * Four selects laid out permanently above the grid is the page for finding
   * something to watch opening on everything except the things to watch.
   * Searching is the common act here; narrowing by genre is occasional.
   *
   * Asserted at this width specifically, because the three tests below open
   * the panel and would therefore pass whether or not it started closed.
   */
  test('the filters start folded away, with search on its own', async ({ page }) => {
    await visit(page, '/browse')

    await expect(page.getByPlaceholder('Search titles, genres and cast')).toBeVisible()
    await expect(page.locator('#browse-filters')).toBeHidden()
    await expect(page.getByLabel('Sort the library')).toBeHidden()

    // The grid is on screen without asking for anything.
    await expect(page.locator('.poster-grid').first()).toBeVisible()

    await openBrowseFilters(page)
    await expect(page.getByLabel('Sort the library')).toBeVisible()
  })

  test('the type filter reaches the API and lands in the URL', async ({ page }) => {
    await visit(page, '/browse')
    await openBrowseFilters(page)

    await expectsRequest(page, /\/api\/library\?.*kind=SHOW/, 'GET', async () => {
      await page.getByLabel('Filter by films or shows').click()
      await page.getByRole('option', { name: 'Shows' }).click()
    })

    await expect(page).toHaveURL(/kind=SHOW/)
  })

  test('the sort control reaches the API and lands in the URL', async ({ page }) => {
    await visit(page, '/browse')
    await openBrowseFilters(page)

    await expectsRequest(page, /\/api\/library\?.*sort=year/, 'GET', async () => {
      await page.getByLabel('Sort the library').click()
      await page.getByRole('option', { name: 'Year' }).click()
    })

    await expect(page).toHaveURL(/sort=year/)
  })

  /**
   * The genre control offers the vocabulary the library actually holds, so a
   * library with no imported metadata legitimately has nothing to offer. The
   * skip is decided from the **data** rather than from `locator.count()`,
   * which does not retry and is therefore always true before the route has
   * rendered — a guard written that way reports green without ever running.
   */
  test('the genre filter offers real genres and narrows the grid', async ({ page }) => {
    await visit(page, '/browse')

    const genres = await page.evaluate(async () => {
      const response = await fetch('/api/library/genres?limit=1')
      return response.ok ? ((await response.json()).items ?? []) : []
    })
    test.skip(genres.length === 0, 'this library has no genres on it yet')
    await openBrowseFilters(page)

    const genre = (genres[0] as { genre: string }).genre
    await expectsRequest(page, /\/api\/library\?.*genre=/, 'GET', async () => {
      await page.getByLabel('Filter by genre').click()
      await page.getByRole('option', { name: genre, exact: true }).click()
    })

    await expect(page).toHaveURL(/genre=/)
    // The chip is how a filter says it is on, and how it is taken off again.
    await expect(page.getByRole('button', { name: `Remove the ${genre} filter` })).toBeVisible()
  })

  /**
   * Browse loads as you reach the end of it rather than paging.
   *
   * Both halves are asserted, because either alone passes on a broken page: the
   * request proves the scroll reached the API, and the growing card count proves
   * the answer was actually put on screen. `expect.poll` retries — a bare
   * `count()` is a single sample and would race the append.
   *
   * The skip comes from the **data**, never from `locator.count()`, which does
   * not retry and is therefore always true before the route has rendered; a
   * guard written that way reports green without ever running. A library holding
   * one page has nothing to scroll to and is not a failure.
   */
  test('browse loads more as you reach the bottom, with no pager', async ({ page }) => {
    await visit(page, '/browse')

    const total = await page.evaluate(async () => {
      const response = await fetch('/api/library?limit=1')
      return response.ok ? ((await response.json()).total ?? 0) : 0
    })
    test.skip(total <= 50, 'this library fits on one page, so there is nothing to scroll for')

    const cards = page.locator('main a[href^="/v/"], main a[href^="/c/"]')
    await expect(cards.first()).toBeVisible()
    const before = await cards.count()

    await expectsRequest(page, /\/api\/library\?.*offset=/, 'GET', async () => {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    })

    await expect.poll(() => cards.count(), { timeout: 15_000 }).toBeGreaterThan(before)

    // The control it replaced is gone rather than hidden — an invisible one that
    // still takes focus is exactly what `visible.spec.ts` exists to catch.
    await expect(page.getByRole('navigation', { name: /pagination/i })).toHaveCount(0)
  })

  /**
   * A tall screen must not be left with empty space below one page of cards.
   *
   * The page keeps loading until the end of the list is off screen, rather than
   * fetching once and stopping. Proving that needs a viewport one page does
   * *not* already fill — at this suite's usual 1280×720, fifty cards overflow
   * several times over and a loader that never fired again would still look
   * perfect. Hence the tall viewport: fifty cards is about six rows, so a 2400px
   * screen shows the end of them and must ask for more without being scrolled.
   */
  test('a tall viewport fills with cards rather than stopping at one page', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 2400 })
    await visit(page, '/browse')

    const total = await page.evaluate(async () => {
      const response = await fetch('/api/library?limit=1')
      return response.ok ? ((await response.json()).total ?? 0) : 0
    })
    test.skip(total <= 50, 'this library fits on one page, so there is nothing to fill with')

    const cards = page.locator('main a[href^="/v/"], main a[href^="/c/"]')
    await expect(cards.first()).toBeVisible()

    // Past one page, with no scrolling — that is the fill loop and nothing else.
    await expect.poll(() => cards.count(), { timeout: 15_000 }).toBeGreaterThan(50)

    // And the grid ends below the fold, so there is no band of empty background
    // under it while there are still titles to show.
    const overflow = await page.evaluate(() => {
      const grid = document.querySelector('.poster-grid')
      return grid ? grid.getBoundingClientRect().bottom - window.innerHeight : 0
    })
    expect(overflow).toBeGreaterThan(0)
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

  /**
   * The half that makes hiding a shelf's videos survivable.
   *
   * A video on a shelf is no longer a card of its own, so if searching its title
   * found nothing it would be unfindable — which is the bug the old, wider film
   * rule existed to fix. Searching one has to answer with the shelf.
   *
   * Both the shelf and the video are chosen from the **data**, never from
   * `locator.count()`: a count guard runs before the client-side route has
   * rendered and is therefore always true, which is how a skip reports green for
   * months. The video is asserted by its own slug rather than by `a[href^="/v/"]`
   * — an unrelated film whose title happens to contain the same word is a
   * perfectly good result and must not fail this.
   */
  test('searching a video on a shelf returns the shelf, not the video', async ({ page }) => {
    await visit(page, '/browse')

    const found = await page.evaluate(async () => {
      const shelves = await (await fetch('/api/collections?limit=20')).json()
      for (const shelf of shelves.items ?? []) {
        const held = await (await fetch(`/api/videos?collectionId=${shelf.id}&limit=1`)).json()
        const video = (held.items ?? [])[0]
        if (video) return { shelf: shelf.slug as string, title: video.title as string, video: video.slug as string }
      }
      return null
    })
    test.skip(found === null, 'no collection in this library holds a video')

    await expectsRequest(page, /\/api\/library\?.*q=/, 'GET', async () => {
      await fillStable(page, SEARCH, found!.title)
    })

    // The shelf is the answer to a title on it...
    await expect(page.locator(`main a[href="/c/${found!.shelf}"]`)).toBeVisible()
    // ...and the video itself is not a second one beside it.
    await expect(page.locator(`main a[href="/v/${found!.video}"]`)).toHaveCount(0)
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
      // This test is about where playback *opens*, not about it running. Left
      // running, the closing assertion below — that starting over went back to
      // the beginning — would be measuring how fast this machine plays.
      await freeze(page)

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
      await freeze(page)
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
      /*
       * Before the position is read, and this is load-bearing twice over: the
       * player runs on its own now, so an anchor read from a moving playhead is
       * stale by the time the marker reaches the API — and the reload below
       * would then open at whatever the beats had since written, which can be
       * past the very intro this test is about to define.
       */
      await freeze(page)
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
      // Metadata rather than `networkidle`: this page is streaming, so the
      // network never falls quiet and waiting for it to would hang until the
      // test times out. Frozen again on the far side too, or the overlay is a
      // five-second window that playback closes while the click is being aimed.
      await withMetadata(page)
      await freeze(page)

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

      // The button reads the server now rather than always starting empty, so a
      // previous run that left this video saved would make the first press a
      // removal and every assertion below meaningless. Start from a known state
      // instead of from whatever the last run happened to leave behind.
      const videoId = await currentVideoId(page)
      await page.evaluate(async (id) => {
        await fetch('/api/me/watchlist', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ videoId: id }),
        })
      }, videoId)
      await page.reload()
      await page.waitForLoadState('networkidle')

      const button = page.getByRole('button', { name: /my list/i })
      await expect(button).toHaveText(/^my list$/i)

      await expectsRequest(page, /\/me\/watchlist/, 'POST', () => button.click())
      await expect(button).toHaveText(/in my list/i)
      await expect(button).toHaveAttribute('aria-pressed', 'true')

      /*
       * The half that was broken, and the only way to catch it: the button
       * painted "My list" for a video already on the list, on every load,
       * because nothing in the page's data ever said it was saved. The state
       * straight after a click is optimistic and looks right either way — it is
       * what survives a reload that says whether the server was ever asked.
       */
      await page.reload()
      await page.waitForLoadState('networkidle')
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
      // Path *and* query: a link built inside a collection now carries `?from=`,
      // and comparing the path alone would both fail to match and stop noticing
      // if the collection were dropped from the link.
      await page.waitForURL(url => url.pathname + url.search === href)

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
    // Path and query, because every link on a collection page now names the
    // collection it came from — see the shelf test above.
    await page.waitForURL(url => url.pathname + url.search === href)
    await expect(page.locator('video')).toBeVisible()
  })

  /**
   * Stepping through a show from the player.
   *
   * The collection is picked from the **data** rather than from
   * `locator.count()`, which does not retry: a guard written with it runs
   * before the list has rendered and skips on every run, which is how a test in
   * this suite reported green for weeks while asserting nothing.
   *
   * At most one season is part of the condition, not a convenience. The
   * collection page orders its list by `orderIndex` alone while the player
   * orders by season first, so within a single season the two provably agree
   * and the first row really is the start of the sequence. Across seasons they
   * need not, and the test would be asserting the page's ordering rather than
   * the player's.
   */
  test('the player steps to the next episode and back again', async ({ page }) => {
    await visit(page, '/browse')
    const slug = await page.evaluate(async () => {
      const list = await (await fetch('/api/collections?limit=100')).json()
      for (const collection of list.items ?? []) {
        const detail = await (await fetch(`/api/collections/${collection.slug}`)).json()
        if ((detail.seasons ?? []).length <= 1 && (detail.videos ?? []).length > 1) {
          return collection.slug as string
        }
      }
      return null
    })
    test.skip(slug === null, 'no collection here holds two videos in one season')

    await visit(page, `/c/${slug}`)

    // Scoped past the hero, whose Play button is also a `/watch/` link — an
    // unscoped `.first()` would click that and never touch an episode row.
    const entry = page.locator('main section ~ div a[href^="/watch/"]').first()
    await expect(entry).toBeVisible()
    await entry.click()
    await page.waitForURL(/\/watch\//)

    const start = page.url()
    expect(
      new URL(start).searchParams.get('from'),
      'the collection has to travel with the link, or the player cannot know which order to step through',
    ).toBe(slug)

    /*
     * Nothing precedes the first episode, and the control says so from where it
     * already is. Removing it would move everything beside it, so the button
     * somebody was aiming at shifts under the pointer at exactly the moment
     * they reach the end of a show.
     */
    await expect(page.getByRole('button', { name: 'Previous episode' })).toBeDisabled()

    const next = page.getByRole('link', { name: 'Next episode' })
    await expect(next).toBeVisible()

    const nextHref = await next.getAttribute('href')
    expect(
      new URL(nextHref!, start).searchParams.get('from'),
      'one step must not drop the collection, or the stepper vanishes underneath whoever is using it',
    ).toBe(slug)

    await next.click()
    await page.waitForURL(url => url.pathname + url.search === nextHref)
    await expect(page.locator('video')).toBeVisible()

    /*
     * And back. The two are mirrors — forward then back is how somebody checks
     * they pressed the right one, and it has to land exactly where they were.
     */
    const back = page.getByRole('link', { name: 'Previous episode' })
    await expect(back).toBeVisible()
    await back.click()
    await page.waitForURL(url => url.href === start)
  })

  /**
   * The stepper is scoped by the URL, and this is what that costs.
   *
   * A video belongs to any number of collections, and where it sits is a fact
   * about one membership — the same episode can be episode 3 of a show and item
   * 1 of a best-of row. So a player reached without a collection named has no
   * running order it could honestly pick, and offers none. Asserted rather than
   * assumed, because the tempting fix is to reach for `collections[0]` and be
   * wrong about half the time.
   */
  test('a player reached without a collection offers no stepper', async ({ page }) => {
    await visit(page, '/browse')
    const slug = await page.evaluate(async () => {
      const body = await (await fetch('/api/videos?limit=1')).json()
      return (body.items?.[0]?.slug ?? null) as string | null
    })
    expect(slug, 'the library holds no video').not.toBeNull()

    // `visitPlayer`, not `visit`: the player starts playing on arrival now, and
    // a page that is streaming never reaches `networkidle` — the ordinary helper
    // waits here until the test dies. This test was written before playback
    // started on its own, and the two changes landed on separate branches, so
    // nothing ran the combination until they were both on main.
    await visitPlayer(page, `/watch/${slug}`)

    // The page itself rendered — otherwise this passes for having found nothing.
    await expect(page.getByRole('link', { name: 'Details' })).toBeVisible()

    await expect(page.getByRole('link', { name: 'Next episode' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Next episode' })).toHaveCount(0)
    await expect(page.getByRole('link', { name: 'Previous episode' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Previous episode' })).toHaveCount(0)

    // And no rail either: it is drawn from the same sequence the stepper walks,
    // so a page that cannot offer one cannot honestly offer the other.
    await expect(page.getByRole('complementary')).toHaveCount(0)
  })

  /**
   * The rest of the collection, beside the player.
   *
   * The stepper answers "what is adjacent"; the rail answers "what is there",
   * which is the question somebody has when they want the episode they skipped.
   * Both are drawn from one sequence, and this pins that they agree — a rail
   * listing a different order from the Next button renders perfectly either way.
   *
   * The collection is chosen from the **data**, never from `locator.count()`,
   * which does not retry: a guard written with it runs before the list has
   * rendered and therefore skips on every run. One did exactly that in this
   * suite for weeks while reporting green.
   */
  test('the player lists the rest of the collection beside it', async ({ page }) => {
    await visit(page, '/browse')
    const found = await page.evaluate(async () => {
      const list = await (await fetch('/api/collections?limit=100')).json()
      for (const collection of list.items ?? []) {
        const detail = await (await fetch(`/api/collections/${collection.slug}`)).json()
        if ((detail.videos ?? []).length > 1) {
          return { slug: collection.slug as string, count: detail.videos.length as number }
        }
      }
      return null
    })
    test.skip(found === null, 'no collection here holds two videos')

    await visit(page, `/c/${found!.slug}`)

    // Scoped past the hero, whose Play button is also a `/watch/` link.
    const entry = page.locator('main section ~ div a[href^="/watch/"]').first()
    await expect(entry).toBeVisible()
    await entry.click()
    await page.waitForURL(/\/watch\//)

    const rail = page.getByRole('complementary')
    await expect(rail).toBeVisible()

    /*
     * A row per video, and no more. The rail is fed the whole sequence, so a
     * short list means the ordering dropped something — which is the failure
     * that looks fine on screen, because a show missing one episode still
     * reads as a show.
     */
    const rows = rail.locator('a[href^="/watch/"]')
    await expect(rows).toHaveCount(found!.count)

    /*
     * Every link carries the collection on. Without it the first click out of
     * the rail is the last one — the rail and the stepper both vanish from the
     * page it lands on, which reads as the app breaking.
     */
    const hrefs = await rows.evaluateAll(links =>
      links.map(link => link.getAttribute('href') ?? ''),
    )
    for (const href of hrefs) {
      expect(
        new URL(href, page.url()).searchParams.get('from'),
        'a rail link that drops the collection ends the rail',
      ).toBe(found!.slug)
    }

    /*
     * And it says which one is playing — announced, not merely tinted. A list
     * of everything with nothing marked is a list you have to read your own
     * address bar to use, and a background colour says that to sighted users
     * only.
     */
    const playing = new URL(page.url()).pathname
    await expect(rail.locator('[aria-current="true"]')).toHaveCount(1)
    await expect(rail.locator(`a[href^="${playing}"]`)).toHaveAttribute('aria-current', 'true')

    // Following a row plays it, rather than describing it.
    const otherHref = hrefs.find(href => !href.startsWith(playing))
    expect(otherHref, 'every row points at the episode already playing').toBeTruthy()
    await rail.locator(`a[href="${otherHref}"]`).click()
    await page.waitForURL(url => url.pathname + url.search === otherHref)
    await expect(page.locator('video')).toBeVisible()

    // The rail survives the trip, which is the whole point of carrying `from`.
    await expect(page.getByRole('complementary')).toBeVisible()
  })

  /**
   * The picture must not resize once the rail's data lands.
   *
   * The player is 16:9 and takes its size from its grid column, so a column
   * decided by the loaded collection is not a control appearing beside some
   * text — it is the video changing size under whoever just pressed Play. It
   * measured 1550px wide and then snapped to 1216px.
   *
   * A **client-side** arrival, because that is the only one that can shift and
   * the reason this went unnoticed: a fresh load is server-rendered, and Nitro
   * fetches the sequence even though it is `lazy` and ships it in the payload,
   * so the rail is in the first paint and nothing moves. Pressing Play on
   * `/v/:slug` is a client navigation into a collection whose sequence is not
   * cached, and there the data genuinely arrives late.
   *
   * The read is held open rather than raced. Without that, "before the data
   * arrives" is a window a fast machine closes before the first measurement,
   * and the test passes by measuring the settled state twice.
   */
  test('the player is one size while the rail is still loading', async ({ page }) => {
    await visit(page, '/browse')
    const found = await page.evaluate(async () => {
      const list = await (await fetch('/api/collections?limit=100')).json()
      for (const collection of list.items ?? []) {
        const detail = await (await fetch(`/api/collections/${collection.slug}`)).json()
        const videos = detail.videos ?? []
        if (videos.length > 1) {
          return { slug: collection.slug as string, first: videos[0].slug as string }
        }
      }
      return null
    })
    test.skip(found === null, 'no collection here holds two videos')

    await page.route(`**/api/collections/${found!.slug}`, async (route) => {
      await new Promise(resolve => setTimeout(resolve, 3000))
      await route.continue()
    })

    await visit(page, `/v/${found!.first}`)
    await page.getByRole('link', { name: /^(Play|Resume)/ }).first().click()
    await page.waitForURL(/\/watch\//)

    await page.locator('video').waitFor({ state: 'attached' })
    const early = await page.locator('video').boundingBox()

    // The measurement is only worth anything taken before the rail exists.
    expect(
      await page.getByRole('complementary').count(),
      'the rail arrived before this could measure without it',
    ).toBe(0)

    await expect(page.getByRole('complementary')).toBeVisible({ timeout: 20_000 })
    const settled = await page.locator('video').boundingBox()

    expect(Math.round(early!.width), 'the player resized as the rail arrived').toBe(
      Math.round(settled!.width),
    )
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

  /**
   * The same fault as the video page's button, on the other screen that carries
   * one — and the reason it is worth its own test: the two read their saved
   * state from different endpoints (`/videos/:id/stats` and
   * `/collections/:slug/progress`), so fixing one proves nothing about the
   * other.
   */
  test('a collection’s my-list button survives a reload', async ({ page }) => {
    // A page of the app first: the fetch below is relative to the origin.
    await visit(page, '/')
    const slug = await page.evaluate(async () => {
      const list = await (await fetch('/api/collections?limit=1')).json()
      return (list.items?.[0]?.slug ?? null) as string | null
    })
    expect(slug, 'the library holds no collection').not.toBeNull()

    await visit(page, `/c/${slug}`)
    const button = page.getByRole('button', { name: /my list/i })
    await expect(button).toBeVisible()

    // Whatever a previous run left behind, start from "not saved".
    if (await button.getAttribute('aria-pressed') === 'true') {
      await expectsRequest(page, /\/me\/watchlist/, 'DELETE', () => button.click())
    }
    await expect(button).toHaveText(/^my list$/i)

    await expectsRequest(page, /\/me\/watchlist/, 'POST', () => button.click())
    await expect(button).toHaveText(/in my list/i)

    await page.reload()
    await page.waitForLoadState('networkidle')
    await expect(button).toHaveText(/in my list/i)
    await expect(button).toHaveAttribute('aria-pressed', 'true')

    await expectsRequest(page, /\/me\/watchlist/, 'DELETE', () => button.click())
  })

  /**
   * The remove button sits over a card that raises *itself* on hover:
   * `.card-lift:hover` scales the card and takes `z-index: 1`, and the button
   * was at `z-index: auto` underneath it. Nobody can reach the button without
   * crossing the card, so the card came forward and covered the only control
   * that takes something off this list — visible at rest, gone the moment you
   * went for it, and clicking where it had been followed the card's link.
   *
   * The test above cannot catch this, and passed throughout. Playwright jumps
   * the mouse straight to its target, so the card is never `:hover` at click
   * time and the button is never covered — a click succeeds against the broken
   * code. The assertion has to be about **stacking while the card is hovered**,
   * which is why this hovers the card and then asks the document what is
   * actually painted at the button's own centre. Do not simplify it back into
   * a click.
   */
  test('the remove button stays on top while the card is hovered', async ({ page }) => {
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
    const card = page.locator('main a[href^="/c/"], main a[href^="/v/"]').first()
    const remove = page.locator('main [aria-label^="Remove"]').first()
    await expect(card).toBeVisible()
    await expect(remove).toBeVisible()

    // The card's centre, which is nowhere near the button — so what happens to
    // the button is the card's doing and not its own hover state.
    await card.hover()

    const onTop = await remove.evaluate((button) => {
      const box = button.getBoundingClientRect()
      const painted = document.elementFromPoint(
        box.left + box.width / 2,
        box.top + box.height / 2,
      )
      return painted !== null && button.contains(painted)
    })
    expect(onTop, 'the hovered card is covering the remove button').toBe(true)
  })
})
