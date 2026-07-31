import { expect, expectApiRejection, expectsRequest, fillStable, signIn, test, toast, visit } from './fixtures'

/** The management screens: every control that changes something. */
test.describe('admin', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page)
  })

  test('the overview tiles lead somewhere', async ({ page }) => {
    await visit(page, '/admin')
    await expect(page.getByRole('heading', { name: 'Manage library' })).toBeVisible()

    await page.getByRole('link', { name: /Drafts waiting/ }).click()
    await page.waitForURL('/admin/drafts')
    await expect(page.getByRole('heading', { name: 'Drafts' })).toBeVisible()
  })

  test('every sidebar section opens', async ({ page }) => {
    await visit(page, '/admin')
    for (const [label, path] of [
      ['Drafts', '/admin/drafts'],
      ['Library', '/admin/library'],
      ['Upload', '/admin/upload'],
      ['Jobs', '/admin/jobs'],
      ['Ingest', '/admin/ingest'],
      ['Curated rows', '/admin/lists'],
      ['People', '/admin/people'],
      ['Accounts', '/admin/users'],
    ] as const) {
      await page.getByRole('link', { name: label, exact: true }).first().click()
      await page.waitForURL(path)
    }
  })

  test('the library state filter narrows the list', async ({ page }) => {
    await visit(page, '/admin/library')
    await expect(page.getByRole('heading', { name: 'Library' })).toBeVisible()

    await fillStable(page, 'input[placeholder="Search titles"]', 'zzzznothing')
    await expect(page.getByText('Nothing matches.')).toBeVisible()
  })

  test('the video editor saves details', async ({ page }) => {
    await visit(page, '/admin/library')
    await page.getByRole('link', { name: 'Edit' }).first().click()
    await page.waitForURL(/\/admin\/videos\//)

    const description = page.getByRole('textbox').nth(1)
    await description.fill(`Edited by the tests ${Date.now()}`)

    await expectsRequest(page, /\/videos\/[^/]+$/, 'PATCH', () =>
      page.getByRole('button', { name: 'Save details' }).click())
    await expect(toast(page, 'Saved')).toBeVisible()
  })

  test('the marker editor sets and clears a marker', async ({ page }) => {
    await visit(page, '/admin/library')
    await page.getByRole('link', { name: 'Edit' }).first().click()
    await page.waitForURL(/\/admin\/videos\//)

    // Move the preview playhead so the marker lands somewhere non-zero.
    await page.locator('video').evaluate((el: HTMLVideoElement) => { el.currentTime = 3 })

    const row = page.locator('div', { hasText: /^Intro start/ }).last()
    await expectsRequest(page, /\/markers$/, 'PATCH', () =>
      row.getByRole('button', { name: 'Set' }).click())

    await expect(page.getByRole('button', { name: 'Clear Intro start' })).toBeVisible()
    await expectsRequest(page, /\/markers$/, 'PATCH', () =>
      page.getByRole('button', { name: 'Clear Intro start' }).click())
  })

  test('re-probe runs against the real file', async ({ page }) => {
    await visit(page, '/admin/library')
    await page.getByRole('link', { name: 'Edit' }).first().click()
    await page.waitForURL(/\/admin\/videos\//)

    await expectsRequest(page, /\/reprobe$/, 'POST', () =>
      page.getByRole('button', { name: 'Re-probe' }).click())
    await expect(toast(page, 'Reprobed')).toBeVisible()
  })

  test('capturing a poster replaces the picture', async ({ page }) => {
    await visit(page, '/admin/library')
    await page.getByRole('link', { name: 'Edit' }).first().click()
    await page.waitForURL(/\/admin\/videos\//)

    const poster = page.locator('img[src*="/thumbnail?v="]')
    const before = await poster.getAttribute('src')

    await expectsRequest(page, /\/thumbnail\/capture$/, 'POST', () =>
      page.getByRole('button', { name: /Capture at/ }).click())

    // The storage key never changes, so the src has to, or the browser keeps
    // showing the picture that was just replaced.
    await expect(poster).not.toHaveAttribute('src', before!)
  })

  test('a curated row can be created, filled, reordered and deleted', async ({ page }) => {
    await visit(page, '/admin/lists')
    const title = `Test row ${Date.now()}`

    await page.getByPlaceholder('New row title').fill(title)
    await expectsRequest(page, /\/lists$/, 'POST', () =>
      page.getByRole('button', { name: 'Add row' }).click())
    await expect(page.getByRole('heading', { name: title })).toBeVisible()

    const card = page.locator('div.rounded-lg', { has: page.getByRole('heading', { name: title }) })

    // Adding an entry goes through a select, which is the fiddliest control here.
    await expectsRequest(page, /\/items$/, 'POST', async () => {
      await card.getByRole('combobox').click()
      await page.getByRole('option').first().click()
    })
    await expect(card.getByRole('button', { name: 'Remove' })).toHaveCount(1)

    await expectsRequest(page, /\/lists\/[^/]+$/, 'PATCH', () =>
      card.getByRole('button', { name: 'Hide' }).click())
    await expect(card.getByText('hidden')).toBeVisible()

    await expectsRequest(page, /\/lists\/[^/]+$/, 'DELETE', () =>
      card.getByRole('button', { name: 'Delete' }).click())
    await expect(page.getByRole('heading', { name: title })).toHaveCount(0)
  })

  test('a person can be added and removed', async ({ page }) => {
    await visit(page, '/admin/people')
    const name = `Test Person ${Date.now()}`

    await page.getByPlaceholder('New person').fill(name)
    await expectsRequest(page, /\/people$/, 'POST', () =>
      page.getByRole('button', { name: 'Add' }).click())
    await expect(page.getByRole('link', { name })).toBeVisible()

    await expectsRequest(page, /\/people\//, 'DELETE', () =>
      page.getByRole('button', { name: `Remove ${name}` }).click())
    await expect(page.getByRole('link', { name })).toHaveCount(0)
  })

  test('minting an invite shows a token exactly once', async ({ page }) => {
    await visit(page, '/admin/users')

    await expectsRequest(page, /\/admin\/invites$/, 'POST', () =>
      page.getByRole('button', { name: 'Mint a token' }).click())

    await expect(page.getByText('Copy this now')).toBeVisible()
    const token = page.locator('code')
    await expect(token).toBeVisible()
    expect((await token.innerText()).length).toBeGreaterThan(20)

    // Held in memory only — a reload must not show it again.
    await page.reload()
    await expect(page.getByText('Copy this now')).toHaveCount(0)
  })

  test('the last admin cannot be demoted', async ({ page }) => {
    await visit(page, '/admin/users')
    // The 409 is the behaviour under test, not an accident.
    expectApiRejection(page, /\/admin\/users\//)
    const row = page.locator('tr', { hasText: '(you)' })

    await row.getByRole('button', { name: /Make viewer/ }).click()
    // The API refuses to strand the library, and the UI has to relay *its*
    // message rather than a generic one — this is the exact wording.
    await expect(toast(page, /no active admin/i)).toBeVisible()
  })

  test('a scan can be started from the ingest page', async ({ page }) => {
    await visit(page, '/admin/ingest')

    await expectsRequest(page, /\/ingest\/scan$/, 'POST', () =>
      page.getByRole('button', { name: 'Scan now' }).click())
    await expect(toast(page, 'Scan finished')).toBeVisible()
  })

  test('the jobs page refreshes on demand', async ({ page }) => {
    await visit(page, '/admin/jobs')

    await expectsRequest(page, /\/admin\/jobs/, 'GET', () =>
      page.getByRole('button', { name: 'Refresh' }).click())
  })

  test('publishing from the drafts inbox is gated on the checklist', async ({ page }) => {
    await visit(page, '/admin/drafts')

    const rows = page.locator('tbody tr')
    if (await rows.count() === 0) test.skip(true, 'no drafts to publish')

    // A draft missing fields must not be selectable — the checklist is the gate.
    const blocked = page.locator('tbody tr', { has: page.getByText('no poster') })
    if (await blocked.count() > 0) {
      await expect(blocked.first().getByRole('checkbox')).toBeDisabled()
    }
  })
})
