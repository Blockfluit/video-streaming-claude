import { AUDIT } from './audit'
import { expect, fillStable, test, visit } from './fixtures'

/*
 * The audit itself lives in `audit.ts` rather than here, because importing it
 * from a *spec* file registers that file's tests as well: pulling `AUDIT` into
 * `mobile.spec.ts` quietly ran the whole legibility suite under the phone
 * project, months before the pages were ready for it.
 */

const PAGES = [
  '/',
  '/browse',
  '/my-list',
  '/history',
  '/requests',
  '/admin',
  '/admin/drafts',
  '/admin/library',
  '/admin/jobs',
  '/admin/ingest',
  '/admin/lists',
  '/admin/people',
  '/admin/users',
  '/admin/upload',
  '/admin/comments',
  '/admin/requests',
]

test.describe('legibility', () => {

  for (const path of PAGES) {
    test(`${path} has no unreadable text or invisible controls`, async ({ page }) => {
      await visit(page, path)
      const problems = await page.evaluate(AUDIT)

      expect(
        problems,
        `${path}:\n${problems.map(p => `  ${p.kind} (${p.value}) — ${p.detail}`).join('\n')}`,
      ).toEqual([])
    })
  }

  /** The pages no static route list can reach: each is behind a click. */
  test("a video's own page too", async ({ page }) => {
    await visit(page, '/browse')
    const slug = await page.evaluate(async () => {
      const body = await (await fetch('/api/videos?limit=1')).json()
      return (body.items?.[0]?.slug ?? null) as string | null
    })
    await visit(page, `/v/${slug}`)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

    const problems = await page.evaluate(AUDIT)
    expect(
      problems,
      `video page:\n${problems.map(p => `  ${p.kind} (${p.value}) — ${p.detail}`).join('\n')}`,
    ).toEqual([])
  })

  /**
   * A person's page too — the one that shipped with `text-white/40` on its
   * empty state, at 3.5:1, below the AA floor. It could not be audited before
   * this: the file sat outside the routed tree, so there was no page to open.
   */
  test('a person page too', async ({ page }) => {
    await visit(page, '/admin/people')
    const slug = await page.evaluate(async () => {
      const body = await (await fetch('/api/people?limit=1')).json()
      return (body.items?.[0]?.slug ?? null) as string | null
    })
    test.skip(slug === null, 'this library holds no people')

    await visit(page, `/people/${slug}`)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

    const problems = await page.evaluate(AUDIT)
    expect(
      problems,
      `person page:\n${problems.map(p => `  ${p.kind} (${p.value}) — ${p.detail}`).join('\n')}`,
    ).toEqual([])
  })

  test('a collection page too', async ({ page }) => {
    await visit(page, '/browse')
    const card = page.locator('main a[href^="/c/"]').first()
    const href = await card.getAttribute('href')
    await card.click()
    await page.waitForURL(url => url.pathname === href)
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

    const problems = await page.evaluate(AUDIT)
    expect(
      problems,
      `collection page:\n${problems.map(p => `  ${p.kind} (${p.value}) — ${p.detail}`).join('\n')}`,
    ).toEqual([])
  })

  test('the player page too', async ({ page }) => {
    await visit(page, '/browse')
    const slug = await page.evaluate(async () => {
      const body = await (await fetch('/api/videos?limit=1')).json()
      return (body.items?.[0]?.slug ?? null) as string | null
    })
    await visit(page, `/v/${slug}`)
    // Playback is a deliberate second press now, so the audit has to take it.
    await page.getByRole('link', { name: /^(Play|Resume)/ }).first().click()
    await page.waitForURL(/\/watch\//)

    // Post a comment so its controls are on the page to be judged. Unique per
    // run, or repeated runs pile up identical text and the locator turns
    // ambiguous.
    const marker = `Legibility check ${Date.now()}`
    await page.getByPlaceholder(/Say something/).fill(marker)
    await page.getByRole('button', { name: 'Post' }).click()
    await expect(page.getByText(marker)).toBeVisible()

    const problems = await page.evaluate(AUDIT)
    expect(
      problems,
      `player:\n${problems.map(p => `  ${p.kind} (${p.value}) — ${p.detail}`).join('\n')}`,
    ).toEqual([])
  })

  /**
   * The player's episode stepper and the rail beside it, which the test above
   * cannot reach.
   *
   * Both render only when the URL names the collection the video was reached
   * through, and that test arrives at the player by clicking Play on a video
   * picked purely by title — which may be in no collection at all. So they were
   * absent exactly when the audit ran, and something never on screen when the
   * audit walks the page has not been judged by it.
   *
   * Addressed directly rather than by clicking through, so the collection is
   * chosen from the data and both are provably present. Which end of the
   * sequence we land on does not matter — the audit is looking at colour.
   *
   * The rail is asserted rather than left to chance: it shares its condition
   * with the stepper today, and a test that covers a thing only by coincidence
   * stops covering it the day that stops being true, without going red.
   */
  test('the player\'s episode stepper and rail too', async ({ page }) => {
    await visit(page, '/browse')
    const target = await page.evaluate(async () => {
      const list = await (await fetch('/api/collections?limit=100')).json()
      for (const collection of list.items ?? []) {
        const detail = await (await fetch(`/api/collections/${collection.slug}`)).json()
        const videos = detail.videos ?? []
        if (videos.length > 1) return `/watch/${videos[0].slug}?from=${collection.slug}`
      }
      return null
    })
    test.skip(target === null, 'no collection here holds two videos')

    await visit(page, target!)
    // By label, so this holds whichever end of the sequence we landed on.
    await expect(page.getByLabel('Next episode')).toBeVisible()
    await expect(page.getByLabel('Previous episode')).toBeVisible()
    await expect(page.getByRole('complementary')).toBeVisible()

    const problems = await page.evaluate(AUDIT)
    expect(
      problems,
      `stepper and rail:\n${problems.map(p => `  ${p.kind} (${p.value}) — ${p.detail}`).join('\n')}`,
    ).toEqual([])
  })

  /**
   * The account panel, which is on every page and on none of them.
   *
   * It is closed until clicked and Reka teleports it to `<body>`, so walking
   * the whole document — which this audit does precisely because of that — still
   * never reached it. Its name and role lines are the only text in the app on
   * the menu's raised surface, and nothing else would have measured them.
   */
  test('the account menu too', async ({ page }) => {
    await visit(page, '/')
    await page.getByRole('button', { name: 'Your account' }).click()
    await expect(page.getByRole('menu')).toBeVisible()

    const problems = await page.evaluate(AUDIT)
    expect(
      problems,
      `account menu:\n${problems.map(p => `  ${p.kind} (${p.value}) — ${p.detail}`).join('\n')}`,
    ).toEqual([])
  })
})

/**
 * The two pages the audit above can never reach.
 *
 * Everything in this suite runs as a signed-in admin, and `auth.global.ts`
 * bounces a signed-in visitor off `/login` and `/setup` to the home page. So
 * the first two screens anyone ever sees were the only real routes in the app
 * whose contrast had never been measured — the audit was blind to them for
 * exactly the reason they exist.
 *
 * Discarding the stored session is the whole fix. The fixture already tolerates
 * a 401 from `/api/auth/me`, which is the ordinary answer out here.
 */
test.describe('legibility, signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  for (const path of ['/login', '/setup']) {
    test(`${path} has no unreadable text or invisible controls`, async ({ page }) => {
      await visit(page, path)

      // Proves the session really was discarded. Signed in, the redirect would
      // land on the home page and this would pass by measuring a page that is
      // already covered above — green, and testing nothing.
      await expect(page).toHaveURL(new RegExp(`${path}$`))

      const problems = await page.evaluate(AUDIT)

      expect(
        problems,
        `${path}:\n${problems.map(p => `  ${p.kind} (${p.value}) — ${p.detail}`).join('\n')}`,
      ).toEqual([])
    })
  }

  /**
   * The checklist in the state nobody looks at twice.
   *
   * Its three states are three different treatments, and the two that only
   * appear after a mistake are never on screen in the test above. Filling the
   * form wrongly on purpose is the only way they get measured.
   */
  test('the signup checklist, once it has something to complain about', async ({ page }) => {
    await visit(page, '/setup')

    // By `name`: both boxes are `autocomplete="new-password"`, so that selector
    // matches two elements and is a strict-mode violation to fill through.
    await fillStable(page, 'input[name="password"]', 'short')
    await fillStable(page, 'input[name="confirmPassword"]', 'different')
    await expect(page.getByText('Passwords match')).toBeVisible()

    const problems = await page.evaluate(AUDIT)
    expect(
      problems,
      `signup checklist:\n${problems.map(p => `  ${p.kind} (${p.value}) — ${p.detail}`).join('\n')}`,
    ).toEqual([])
  })
})
