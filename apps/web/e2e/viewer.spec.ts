import { expect, expectsRequest, fillStable, signIn, test, visit } from './fixtures'

/** The viewer-facing app: every control a member can press. */
test.describe('viewer', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page)
  })

  test('the hero play button reaches a player', async ({ page }) => {
    await visit(page, '/')
    const hero = page.getByRole('link', { name: /^(Resume|Play)$/ })
    await expect(hero).toBeVisible()

    await hero.click()
    await page.waitForURL(/\/c\//)
    await expect(page.locator('video')).toBeVisible()
  })

  test('a card opens its video', async ({ page }) => {
    await visit(page, '/')
    const card = page.locator('main a[href^="/c/"]').first()
    const href = await card.getAttribute('href')

    await card.click()
    await page.waitForURL(url => url.pathname === href)
    await expect(page.locator('video')).toBeVisible()
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
      await visit(page, '/')
      await page.locator('main a[href^="/c/"]').first().click()
      await page.waitForURL(/\/c\/.+\/.+/)
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
      const videoId = await page.evaluate(async () => {
        const response = await fetch('/api/me/history?limit=1')
        const page_ = await response.json()
        return page_.items[0]?.video?.id as string | undefined
      })
      const target = videoId ?? (await page.evaluate(async () => {
        const response = await fetch('/api/videos?limit=1')
        return (await response.json()).items[0].id as string
      }))

      await page.evaluate(async (id) => {
        await fetch(`/api/videos/${id}/markers`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ introStartSec: 0, introEndSec: 5 }),
        })
      }, target)
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
      await video.evaluate((el: HTMLVideoElement) => { el.currentTime = 8 })

      await page.getByPlaceholder(/Say something/).fill('Pinned by the tests')
      await page.getByRole('checkbox').check()
      await page.getByRole('button', { name: 'Post' }).click()

      const stamp = page.getByRole('button', { name: /^\d+:\d\d$/ }).first()
      await expect(stamp).toBeVisible()

      await video.evaluate((el: HTMLVideoElement) => { el.currentTime = 0 })
      await stamp.click()
      await expect
        .poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime))
        .toBeGreaterThan(5)
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
      const sidebar = page.getByText('More from')
      if (await sidebar.count() === 0) test.skip(true, 'only one video in this collection')

      const other = page.locator('aside a').nth(1)
      const href = await other.getAttribute('href')
      await other.click()
      await page.waitForURL(url => url.pathname === href)
      await expect(page.locator('video')).toBeVisible()
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
