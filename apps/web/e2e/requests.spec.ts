import {
  expect,
  expectApiRejection,
  expectsRequest,
  fillStable,
  test,
  toast,
  visit,
} from './fixtures'

/**
 * Asking for something the library does not have.
 *
 * Both halves are here because they are the same rows seen two ways: the viewer
 * page hides who asked, the admin queue is the only place a status can be
 * changed. The assertions go through `expectsRequest` — a status dropdown that
 * renders perfectly and never calls the API looks identical from the outside.
 */

/** Unique per run: the API refuses a second *open* request for the same title. */
const title = () => `Test Request ${Date.now()}`

test.describe('requests', () => {
  /*
   * Starts from History rather than the home page: the nav is the same on every
   * viewer screen, and the home page pulls artwork for whatever is in the
   * library — which makes this test's result depend on the fixtures having
   * posters rather than on the link working.
   */
  test('the viewer page is reachable from the nav', async ({ page }) => {
    await visit(page, '/history')

    await page.getByRole('link', { name: 'Requests', exact: true }).first().click()
    await page.waitForURL('**/requests')

    await expect(page.getByRole('heading', { name: 'Requests', level: 1 })).toBeVisible()
  })

  test('submitting a request adds it to the list', async ({ page }) => {
    const wanted = title()
    await visit(page, '/requests')

    await fillStable(page, 'input[placeholder="What would you like to watch?"]', wanted)

    await expectsRequest(page, /\/api\/requests$/, 'POST', async () => {
      await page.getByRole('button', { name: 'Request it' }).click()
    })

    await expect(toast(page, 'Requested')).toBeVisible()
    // It comes back from the API, marked as the caller's own.
    await expect(page.getByRole('heading', { name: wanted, level: 3 })).toBeVisible()
    await expect(
      page.locator('article').filter({ hasText: wanted }).getByText('yours'),
    ).toBeVisible()
  })

  /**
   * The existence check, end to end. "The Matrix" is seeded before the run, and
   * the refusal has to land in the form with a way to go and look — not in a
   * toast that takes the one actionable piece of information away after four
   * seconds.
   */
  test('a title already in the library is refused, with a link to it', async ({ page }) => {
    // A 409 here is the feature working, not a failure.
    expectApiRejection(page, /\/api\/requests/)

    await visit(page, '/requests')
    await fillStable(page, 'input[placeholder="What would you like to watch?"]', 'the matrix!')

    await expectsRequest(page, /\/api\/requests$/, 'POST', async () => {
      await page.getByRole('button', { name: 'Request it' }).click()
    })

    // Normalisation is what makes "the matrix!" find "The Matrix".
    await expect(page.getByText(/already in the library/i)).toBeVisible()
    await expect(page.getByRole('link', { name: 'Go and have a look' })).toBeVisible()
  })

  test('the admin queue shows who asked, and can change the status', async ({ page }) => {
    const wanted = title()

    await visit(page, '/requests')
    await fillStable(page, 'input[placeholder="What would you like to watch?"]', wanted)
    await expectsRequest(page, /\/api\/requests$/, 'POST', async () => {
      await page.getByRole('button', { name: 'Request it' }).click()
    })

    await visit(page, '/admin/requests')

    const row = page.locator('article').filter({ hasText: wanted })
    await expect(row).toBeVisible()
    // The whole reason the admin screen is separate.
    await expect(row.getByText(/Asked by/)).toBeVisible()
    await expect(row.getByText('ada')).toBeVisible()

    /*
     * `USelect` is a Reka UI listbox, not a native `<select>` — `selectOption`
     * finds nothing and silently never fires the request. Driving it the way a
     * person does is also the only way to prove the popover, which Reka teleports
     * to `<body>`, is wired to the handler.
     */
    await expectsRequest(page, /\/api\/requests\/[^/]+\/status$/, 'PATCH', async () => {
      await row.getByLabel(`Set the status of the request for ${wanted}`).click()
      await page.getByRole('option', { name: 'Processing' }).click()
    })

    await expect(toast(page, /Marked processing/i)).toBeVisible()
  })

  test('the admin queue is reachable from the sidebar', async ({ page }) => {
    await visit(page, '/admin')

    await page.getByRole('link', { name: 'Requests' }).first().click()
    await page.waitForURL('**/admin/requests')

    await expect(page.getByRole('heading', { name: 'Requests', level: 1 })).toBeVisible()
  })
})
