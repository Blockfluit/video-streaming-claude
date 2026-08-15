import { expect } from '@playwright/test'

import { test, visit } from './fixtures'

/**
 * The home hero: what it features, that it plays, and that it moves on.
 *
 * This is the one place in the suite that opts **back out** of the reduced
 * motion the config asks for globally. Everything the hero does on its own —
 * the trailer, the rotation — is suppressed under that setting by design, so
 * without opting out there would be no coverage of either: the feature would be
 * switched off in every test that could have caught it breaking.
 *
 * YouTube is stubbed rather than reached. A test that needs the internet to be
 * green is a test that goes red for reasons that have nothing to do with this
 * app, and the fixture's watchdog fails any response ≥400 in any frame —
 * including somebody else's beacon.
 */
test.describe('the home hero', () => {
  test.use({ reducedMotion: 'no-preference' })

  /**
   * Nothing leaves the machine, and the iframe still mounts and loads.
   *
   * Scoped to the two YouTube hosts rather than a `*youtube*` glob. The broad
   * pattern also matched Vite's own module requests during a dev run — the page
   * came back as a 500 with "failed to fetch dynamically imported module", which
   * reads as a broken component and is really an over-eager stub.
   */
  test.beforeEach(async ({ page }) => {
    await page.route(/youtube(-nocookie)?\.com/, route =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>stub</title>' }),
    )
  })

  interface Featured {
    kind: 'collection' | 'video'
    id: string
    title: string
  }

  /**
   * What the page will lead with, and — unlike `heroEntries` — the id of the
   * *record* behind it.
   *
   * The helper deliberately returns the row's item id, which is a `ListItem` id
   * or a synthetic `collection:<id>`, because that is what the rotation keys on.
   * A test that wants to give the featured title a trailer needs the thing
   * itself, so it repeats the choosing rule rather than the mapping.
   */
  async function featured(page: import('@playwright/test').Page): Promise<Featured | null> {
    return page.evaluate(async () => {
      const [rows, newest] = await Promise.all([
        (await fetch('/api/lists?limit=20')).json(),
        (await fetch('/api/library?sort=added&limit=5')).json(),
      ])

      const row = rows.items.find(
        (item: { source: string, items: unknown[] }) =>
          item.source === 'RECENTLY_ADDED' && item.items.length > 0,
      )

      if (row) {
        const entry = row.items[0]
        return entry.collection
          ? { kind: 'collection' as const, id: entry.collection.id, title: entry.collection.title }
          : { kind: 'video' as const, id: entry.video.id, title: entry.video.title }
      }

      const card = newest.items[0]
      if (!card) return null

      return {
        kind: card.kind === 'collection' ? ('collection' as const) : ('video' as const),
        id: card.id,
        title: card.title,
      }
    })
  }

  /** How many entries the hero has to rotate through. */
  async function entryCount(page: import('@playwright/test').Page): Promise<number> {
    return page.evaluate(async () => {
      const [rows, newest] = await Promise.all([
        (await fetch('/api/lists?limit=20')).json(),
        (await fetch('/api/library?sort=added&limit=5')).json(),
      ])

      const row = rows.items.find(
        (item: { source: string, items: unknown[] }) =>
          item.source === 'RECENTLY_ADDED' && item.items.length > 0,
      )

      return Math.min(row ? row.items.length : newest.items.length, 5)
    })
  }

  async function setTrailer(
    page: import('@playwright/test').Page,
    entry: Featured,
    trailer: string,
  ): Promise<void> {
    const path = entry.kind === 'collection' ? 'collections' : 'videos'
    await page.evaluate(
      async ({ path, id, trailer }) => {
        await fetch(`/api/${path}/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trailerYoutubeId: trailer }),
        })
      },
      { path, id: entry.id, trailer },
    )
  }

  /**
   * The ask this branch exists for: the hero plays the trailer rather than
   * sitting on a still banner.
   *
   * The trailer is set through the API rather than assumed, because most of a
   * library has none — a test that skipped when it found no trailer would be a
   * test that never ran. Restored afterwards so the library is left as found.
   */
  test('plays the trailer of what it features, muted', async ({ page }) => {
    await visit(page, '/')

    const entry = await featured(page)
    test.skip(entry === null, 'the library is empty')

    await setTrailer(page, entry!, 'dQw4w9WgXcQ')

    try {
      await visit(page, '/')
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(entry!.title)

      // Mounted only once it starts, two seconds in, so nothing is requested
      // from YouTube on a page someone passes through.
      const trailer = page.locator('iframe[src*="youtube"]')
      await expect(trailer).toHaveCount(1, { timeout: 15_000 })

      // Muted is not a preference: a browser refuses to start an unmuted video
      // nobody asked for, and it fails silently — the iframe loads and sits there.
      await expect(trailer).toHaveAttribute('src', /mute=1/)

      // The controls that let a person turn it off, which is the other half of
      // starting something on its own.
      await expect(page.getByRole('button', { name: 'Stop the trailer' })).toBeVisible()
    }
    finally {
      await setTrailer(page, entry!, '')
    }
  })

  /**
   * "Then play the next in line."
   *
   * Skipped from the *data* rather than from a locator count: `count()` does not
   * retry, so a guard written against the DOM runs before the route has
   * rendered and is therefore always true — a skip that never runs reports
   * green, which is worse than no test at all.
   */
  test('moves on to the next recent arrival', async ({ page }) => {
    await visit(page, '/')

    const count = await entryCount(page)
    test.skip(count < 2, 'the library has only one recent entry to show')

    const heading = page.getByRole('heading', { level: 1 })
    const first = await heading.textContent()

    // Longer than the rotation itself, so a slow machine is not a failure.
    await expect(heading).not.toHaveText(first ?? '', { timeout: 20_000 })
  })

  /**
   * The pill fills as the entry's turn runs out, which is the whole reason the
   * active bullet is a pill rather than a dot.
   *
   * Measured rather than asserted on a class: a bar bound to a value that never
   * changes renders perfectly, and that is precisely the failure worth catching
   * here. The fill has no test hook of its own — this suite has none anywhere —
   * so it is reached through the `aria-current` the active bullet already
   * carries.
   *
   * A ratio rather than two absolute widths, because the pill itself is only
   * 40px: a couple of seconds of a ten-second turn is a handful of pixels, and
   * demanding an exact number would fail on a machine that dropped frames.
   */
  test('fills the active bullet as its turn runs out', async ({ page }) => {
    await visit(page, '/')

    const count = await entryCount(page)
    test.skip(count < 2, 'the library has only one recent entry to show')

    const pill = page.locator('[aria-current="true"]')
    const progress = pill.locator('span')
    await expect(progress).toHaveCount(1)

    // Away from the hero, or hovering would hold the rotation still and the
    // fill with it — which is correct behaviour and would fail this test.
    await page.mouse.move(0, 0)

    /**
     * Zero is a real width here — the fill starts empty — and Playwright treats
     * an element with an empty box as hidden, so `toBeVisible` and a bare `!`
     * on `boundingBox()` would both be reading the state under test as a fault.
     */
    const widthOf = async (locator: typeof progress): Promise<number> =>
      (await locator.boundingBox())?.width ?? 0

    const started = await widthOf(progress)
    const track = await widthOf(pill)

    await page.waitForTimeout(2000)

    const later = await widthOf(progress)

    // Grown, and not yet finished: two seconds into a ten-second turn.
    expect(later).toBeGreaterThan(started)
    expect(later).toBeLessThan(track)
  })

  /**
   * Auto-updating content needs a way to stop it, and "wait, what was that" is
   * the commonest reason to want one.
   *
   * The control is the active bullet itself now. The button that used to sit
   * beside it took its label from `rotating`, which is false while the pointer
   * is on the hero — so it read "Resume the rotation" from the moment anyone
   * reached for it and never changed. This asserts the label flips under the
   * click, with the pointer still where clicking left it.
   */
  test('holds still once the rotation is paused', async ({ page }) => {
    await visit(page, '/')

    const count = await entryCount(page)
    test.skip(count < 2, 'the library has only one recent entry to show')

    await page.getByRole('button', { name: 'Pause the rotation' }).click()

    // Still hovering the hero, which is what broke the old control.
    await expect(page.getByRole('button', { name: 'Resume the rotation' })).toBeVisible()

    const heading = page.getByRole('heading', { level: 1 })
    const held = await heading.textContent()

    // Two full turns' worth. If it were still rotating it would have moved.
    await page.waitForTimeout(12_000)
    await expect(heading).toHaveText(held ?? '')
    await expect(page.getByRole('button', { name: 'Resume the rotation' })).toBeVisible()
  })

  /** Picking one by hand is a decision, so it stops the carousel moving under you. */
  test('shows the entry a dot names, and stops rotating', async ({ page }) => {
    await visit(page, '/')

    const count = await entryCount(page)
    test.skip(count < 2, 'the library has only one recent entry to show')

    const second = page.getByRole('button', { name: /^Show / }).nth(1)
    const wanted = (await second.getAttribute('aria-label'))!.replace(/^Show /, '')

    await second.click()

    await expect(page.getByRole('heading', { level: 1 })).toHaveText(wanted)
    await expect(page.getByRole('button', { name: 'Resume the rotation' })).toBeVisible()
  })
})
