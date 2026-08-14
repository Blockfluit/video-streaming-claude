import {
  expect,
  expectApiRejection,
  expectsRequest,
  fillStable,
  removeSeasonWithFolder,
  savesThenRestores,
  test,
  toast,
  USERNAME,
  visit,
} from './fixtures'

/** The management screens: every control that changes something. */
test.describe('admin', () => {

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
      ['Home page rows', '/admin/lists'],
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

  /**
   * Browse carries a lifecycle filter that only an admin is shown.
   *
   * The rendering is gated on `isAdmin`, which is a convenience rather than an
   * authority — the API narrows a caller's `state` to what their role may see,
   * so a viewer who writes the parameter by hand gets an empty page. This
   * asserts the half a browser can see: that an admin gets the control, and
   * that it reaches the endpoint.
   */
  test('an admin can filter browse by lifecycle state', async ({ page }) => {
    await visit(page, '/browse')

    await expectsRequest(page, /\/api\/library\?.*state=DRAFT/, 'GET', async () => {
      await page.getByLabel('Filter by lifecycle state').click()
      await page.getByRole('option', { name: 'Draft' }).click()
    })

    await expect(page).toHaveURL(/state=DRAFT/)
  })

  test('the video editor saves details', async ({ page }) => {
    await visit(page, '/admin/library')
    await page.getByRole('link', { name: 'Edit' }).first().click()
    await page.waitForURL(/\/admin\/videos\//)

    // Restores the description afterwards: this runs against the real library,
    // and the text it types is otherwise still on the film the next time anyone
    // opens it.
    await savesThenRestores(
      page,
      page.getByRole('textbox').nth(1),
      `Edited by the tests ${Date.now()}`,
      /\/videos\/[^/]+$/,
      'Save details',
    )
  })

  /**
   * The delete dialog, asserted up to the point of no return.
   *
   * Neither button is pressed. This suite runs against the real dev library, so
   * the only thing there is to delete is a real film — and there is no cheap way
   * to make a throwaway one, because a video row exists only where a file does.
   * The API side is covered by `library.db-spec.ts`; what is worth proving here
   * is that the warning a person reads before deciding is actually on screen.
   */
  test('removing a video names the file and warns that a scan brings it back', async ({ page }) => {
    await visit(page, '/admin/library')
    await page.getByRole('link', { name: 'Edit' }).first().click()
    await page.waitForURL(/\/admin\/videos\//)

    // The storage key is on the page header, and the dialog must name the same
    // file — that is the whole "say what goes" convention.
    const storageKey = await page.locator('main').getByText(/\.(mp4|mkv|avi|mov|webm)$/).first().innerText()

    await page.getByRole('button', { name: 'Remove this entry' }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Remove this video from the library')).toBeVisible()
    await expect(dialog.getByText(storageKey)).toBeVisible()
    await expect(dialog.getByText(/GB/)).toBeVisible()
    // The warning this feature exists for.
    await expect(dialog.getByText(/recreate this video as an untitled draft/)).toBeVisible()
    await expect(dialog.getByRole('button', { name: /delete the file/ })).toBeVisible()

    await dialog.getByRole('button', { name: 'Cancel' }).click()

    // A closing overlay still swallows pointer events, so wait for it to go.
    await expect(page.getByRole('dialog')).toHaveCount(0)
    // Cancelling navigated nowhere and deleted nothing.
    await expect(page).toHaveURL(/\/admin\/videos\//)
    await expect(page.getByRole('button', { name: 'Remove this entry' })).toBeVisible()
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

  /**
   * Both shapes, and each on its own.
   *
   * The sources are tracked per shape so an admin can hand-pick a poster and
   * still let the banner regenerate, which means capturing one must not disturb
   * the other — including its cache-buster, or the screen would claim a change
   * that never happened.
   */
  for (const shape of ['poster', 'banner'] as const) {
    test(`capturing a ${shape} replaces that picture and no other`, async ({ page }) => {
      await visit(page, '/admin/library')
      await page.getByRole('link', { name: 'Edit' }).first().click()
      await page.waitForURL(/\/admin\/videos\//)

      const target = page.locator(`img[src*="/${shape}?v="]`)
      const other = page.locator(`img[src*="/${shape === 'poster' ? 'banner' : 'poster'}?v="]`)
      await expect(target).toBeVisible()

      const before = await target.getAttribute('src')
      const otherBefore = await other.getAttribute('src')

      await expectsRequest(page, new RegExp(`/${shape}/capture$`), 'POST', () =>
        page.getByRole('button', { name: /Capture at/ }).nth(shape === 'poster' ? 0 : 1).click())

      // The storage key never changes, so the src has to, or the browser keeps
      // showing the picture that was just replaced.
      await expect(target).not.toHaveAttribute('src', before!)
      await expect(other).toHaveAttribute('src', otherBefore!)
    })
  }

  /**
   * Reached by clicking the sidebar, not by `goto`.
   *
   * The page once shipped throwing in `setup` — its whole content area rendered
   * as nothing inside an intact admin layout — and the stack came through
   * Suspense's `registerDep`, which is the client-side navigation path. A direct
   * `goto` server-renders first and is a different route into the same screen,
   * so this asserts the one that actually broke.
   *
   * Its real assertion is the `pageerror` watchdog in `fixtures.ts`. Note it can
   * only catch a *dev-mode* throw: the fault that prompted this test appeared
   * solely in the production build, and this suite runs against the dev servers.
   * `app/utils/auto-imports.spec.ts` is what covers that half.
   */
  test('the home page rows screen renders when opened from the sidebar', async ({ page }) => {
    await visit(page, '/admin')
    await page.getByRole('link', { name: 'Home page rows', exact: true }).first().click()
    await page.waitForURL('/admin/lists')

    await expect(page.getByRole('heading', { name: 'Home page rows' })).toBeVisible()
    await expect(page.getByPlaceholder('New row title')).toBeVisible()

    // Seeded by the configurable-home-rows migration, so they are always there.
    await expect(page.getByRole('heading', { name: 'Continue watching' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'My list' })).toBeVisible()
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

  /**
   * The credits editor, driven through its real controls.
   *
   * Worth covering carefully: the credits API shipped in step 16 and nothing in
   * the frontend called it until now, so the merge rules and the billing order
   * were reachable only from a unit test. It also has to clean up after itself
   * — a credit is a duplicate on (person, role, parent) and the second run of a
   * test that leaves one behind gets a 409.
   */
  test('a person can be credited on a video and removed again', async ({ page }) => {
    const name = `Credited ${Date.now()}`

    await visit(page, '/admin/people')
    await fillStable(page, 'input[placeholder="New person"]', name)
    await expectsRequest(page, /\/people$/, 'POST', () =>
      page.getByRole('button', { name: 'Add' }).click())
    await expect(page.getByRole('link', { name })).toBeVisible()

    /*
     * Pick the video from the home page and resolve *that* one's id, rather
     * than crediting `videos?limit=1` and then opening whichever card the home
     * page happens to show first. Those are two different orderings and they
     * disagree — the first draft of this test credited Chinatown and then
     * asserted against South Park.
     */
    /*
     * A video addresses itself now, so one listing answers both halves: the id
     * to credit against, and the page to check the panel on. There is no second
     * ordering left to disagree with.
     */
    await visit(page, '/')
    const target = await page.evaluate(async () => {
      const body = await (await fetch('/api/videos?limit=1')).json()
      const video = body.items?.[0]
      return video ? { id: video.id as string, page: `/v/${video.slug}` } : null
    })
    expect(target, 'the library holds no video to credit').not.toBeNull()
    const videoId = target!.id

    await visit(page, `/admin/videos/${videoId}`)

    await expect(page.getByRole('heading', { name: 'Cast and crew' })).toBeVisible()

    // The trigger carries an explicit aria-label: USelectMenu's own is
    // "Show popup", which shadows the visible text and names the control
    // after its mechanism rather than its job.
    await page.getByRole('button', { name: 'Person to credit' }).click()
    await page.getByRole('option', { name }).click()

    /*
     * Picking someone must close the menu, and this waits for it rather than
     * racing it. While the popover is open its focus trap owns the keyboard, so
     * the character name typed next lands in the *search box* instead — the
     * credit then saves with no character and nothing anywhere reports an
     * error. That is a real bug this assertion pins, not test hygiene.
     */
    await expect(page.getByRole('listbox')).toHaveCount(0)

    await fillStable(page, 'input[placeholder="Optional"]', 'Herself')

    await expectsRequest(page, /\/credits$/, 'POST', () =>
      page.getByRole('button', { name: 'Add credit' }).click())
    await expect(page.getByText(name)).toBeVisible()

    // And it must reach the viewer-facing panel, not just the editor. That
    // panel lives on the video's own page rather than beside the player.
    await visit(page, target!.page)
    await expect(page.getByRole('heading', { name: 'Cast and crew' })).toBeVisible()
    await expect(page.getByText(name)).toBeVisible()
    await expect(page.getByText('as Herself')).toBeVisible()

    // Clean up, or the next run collides on (person, role, parent).
    await visit(page, `/admin/videos/${videoId}`)
    await expectsRequest(page, /\/credits\//, 'DELETE', () =>
      page.getByRole('button', { name: `Remove ${name}` }).click())
    await expect(page.getByText(name)).toHaveCount(0)
  })

  /**
   * The collection editor. Before it existed the admin screens could edit a
   * video and nothing else — a show's title, state, seasons and shared cast
   * were reachable only through the API.
   */
  test('a collection can be edited, and its seasons managed', async ({ page }) => {
    await visit(page, '/admin/library')
    await page.locator('main a[href^="/admin/collections/"]').first().click()
    await page.waitForURL(/\/admin\/collections\//)

    await expect(page.getByRole('heading', { name: 'Details' })).toBeVisible()

    // Saving has to reach the API — a form that only updates itself is the
    // exact failure this suite exists to catch — and then the collection's own
    // description goes back, for the same reason as on the video editor.
    await savesThenRestores(
      page,
      page.locator('textarea'),
      `Edited by the tests ${Date.now()}`,
      /\/collections\/[^/]+$/,
      'Save changes',
    )

    // Aggregate figures are ADMIN-only and had no reader anywhere in the app.
    await expect(page.getByText('Viewers')).toBeVisible()
    await expect(page.getByText('Avg. completion')).toBeVisible()

    // A season, then the same season away again — otherwise repeated runs pile
    // up seasons on the one collection the fixtures have.
    const seasons = page.locator('h3').filter({ hasText: /^Season \d+$/ })
    const before = await seasons.count()

    await fillStable(page, 'input[placeholder="Number"]', String(90 + before))
    await expectsRequest(page, /\/seasons$/, 'POST', () =>
      page.getByRole('button', { name: 'Add', exact: true }).click())
    await expect(seasons).toHaveCount(before + 1)

    await expectsRequest(page, /\/seasons\//, 'DELETE', () =>
      page.getByRole('button', { name: `Remove Season ${90 + before}` }).click())
    await expect(seasons).toHaveCount(before)

    /*
     * The row is gone but the folder is not — creating a season creates one in
     * MEDIA_ROOT, and the UI deliberately does not offer deleteFiles. The scan
     * this suite runs a few tests later would rebuild the row from that folder,
     * so the season has to be removed properly or it comes back and shifts the
     * page under whatever runs next.
     */
    await removeSeasonWithFolder(page, 90 + before)
  })

  /**
   * Dragging an episode into a season, and the drop position becoming the
   * playing order.
   *
   * Asserts the **request**, not just the rearranged DOM: a list that reorders
   * under the cursor and never tells the server is exactly the kind of control
   * that looks like it works and does nothing.
   */
  test('an episode can be dragged into a season, and the order sticks', async ({ page }) => {
    await visit(page, '/admin/library')
    await page.locator('main a[href^="/admin/collections/"]').first().click()
    await page.waitForURL(/\/admin\/collections\//)

    // A season of its own, so this does not fight the other tests over one.
    const number = 70 + (Date.now() % 20)
    await fillStable(page, 'input[placeholder="Number"]', String(number))
    await expectsRequest(page, /\/seasons$/, 'POST', () =>
      page.getByRole('button', { name: 'Add', exact: true }).click())

    const season = page.getByRole('region', { name: `Season ${number}` })
    await expect(season.getByText('Drop an episode here.')).toBeVisible()

    // Scoped to the loose group, not "the first draggable row on the page" —
    // with a season above it that is a different episode.
    const loose = page.getByRole('region', { name: 'Not in a season' })
    const episode = loose.locator('li[draggable="true"]').first()
    const title = (await episode.innerText()).split('\n').filter(Boolean)[1]

    // Playwright's dragTo issues the real HTML5 drag events the handlers use.
    await expectsRequest(page, /\/videos\/order$/, 'PATCH', () =>
      episode.dragTo(season))

    // It is in the season now, and numbered from one.
    const moved = season.locator('li[draggable="true"]')
    await expect(moved).toHaveCount(1)
    await expect(moved.first()).toContainText(title as string)

    // And it survives a reload, which is the part a purely local reorder fails.
    await page.reload()
    await page.waitForLoadState('networkidle')
    const after = page.getByRole('region', { name: `Season ${number}` })
    await expect(after.locator('li[draggable="true"]')).toHaveCount(1)

    // Put the episode back where it started.
    await expectsRequest(page, /\/videos\/order$/, 'PATCH', () =>
      after.locator('li[draggable="true"]').first()
        .dragTo(page.getByRole('region', { name: 'Not in a season' })))

    // Removes the folder too, or the scan later in this suite rebuilds the row.
    await removeSeasonWithFolder(page, number)
  })

  /**
   * Deleting a season now sticks, because the empty folder goes with it —
   * previously the next scan rebuilt the row from that folder and the deletion
   * appeared to undo itself.
   *
   * A season that still holds episodes is the dangerous case and is confirmed
   * first, because removing its files means removing films.
   */
  test('deleting a season warns when it still holds episodes', async ({ page }) => {
    await visit(page, '/admin/library')
    await page.locator('main a[href^="/admin/collections/"]').first().click()
    await page.waitForURL(/\/admin\/collections\//)

    const number = 40 + (Date.now() % 20)
    await fillStable(page, 'input[placeholder="Number"]', String(number))
    await expectsRequest(page, /\/seasons$/, 'POST', () =>
      page.getByRole('button', { name: 'Add', exact: true }).click())

    const season = page.getByRole('region', { name: `Season ${number}` })
    // Wait for the new season to render before dragging onto it — a drop that
    // lands mid-re-render goes nowhere, and the request never fires.
    await expect(season.getByText('Drop an episode here.')).toBeVisible()

    const episode = page.getByRole('region', { name: 'Not in a season' })
      .locator('li[draggable="true"]').first()
    await expectsRequest(page, /\/videos\/order$/, 'PATCH', () => episode.dragTo(season))
    await expect(season.locator('li[draggable="true"]')).toHaveCount(1)

    // Now it holds something, so the delete must stop and explain.
    await page.getByRole('button', { name: `Remove Season ${number}` }).click()
    await expect(page.getByText('This season still has episodes')).toBeVisible()
    await expect(page.getByText(/recreate the season/)).toBeVisible()

    // Backing out leaves everything alone — including the film.
    await page.getByRole('button', { name: 'Cancel' }).click()
    // Wait for the dialog to actually go: while it is closing its overlay still
    // swallows pointer events, so the drag below lands on nothing and the
    // request never fires.
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(season.locator('li[draggable="true"]')).toHaveCount(1)

    /*
     * Cleanup goes through the API, not the UI.
     *
     * The destructive button is deliberately not pressed: it deletes the video
     * file, and that file is a real film in the dev library. And the episode is
     * moved out by request rather than by dragging — dragging straight after
     * the dialog closes is timing-sensitive and this test is about the warning,
     * not about the drag, which the previous test already covers.
     */
    await page.evaluate(async (seasonNumber) => {
      const collections = await (await fetch('/api/collections?limit=1')).json()
      const collection = collections.items[0]
      const detail = await (await fetch(`/api/collections/${collection.slug}`)).json()
      const season = detail.seasons.find(
        (candidate: { number: number | null }) => candidate.number === seasonNumber,
      )
      if (!season) return

      // Empty it first, so deleting the season never has files to consider.
      await fetch(`/api/collections/${collection.id}/videos/order`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seasonId: null, videoIds: detail.videos.map((v: { id: string }) => v.id) }),
      })
      await fetch(`/api/seasons/${season.id}`, { method: 'DELETE' })
    }, number)

    // The empty folder goes with the row, which is the point of this branch:
    // reload and the season is not rebuilt from a directory left behind.
    await page.reload()
    await page.waitForLoadState('networkidle')
    await expect(page.getByRole('region', { name: `Season ${number}` })).toHaveCount(0)
  })

  /**
   * The player carries its own way into the editor.
   *
   * A wrong title or a misplaced marker is noticed with the video playing, and
   * `/v/:slug` having the button is no help from `/watch/:slug`. Gated on
   * `isAdmin`, which is a convenience rather than an authority — the editor is
   * behind `middleware/admin.ts` and behind the API either way. This asserts
   * the half a browser can see: the control is there, and it lands on the
   * editor for *this* video rather than on the admin library.
   */
  test('the player page links to this video\'s editor', async ({ page }) => {
    // Somewhere in the app first — a relative fetch has no base URL to resolve
    // on about:blank.
    await visit(page, '/browse')
    const video = await page.evaluate(async () => {
      const body = await (await fetch('/api/videos?limit=1')).json()
      const first = body.items?.[0]
      return first ? { id: first.id as string, slug: first.slug as string } : null
    })
    expect(video).not.toBeNull()

    await visit(page, `/watch/${video!.slug}`)

    const edit = page.getByRole('link', { name: 'Edit' })
    await expect(edit).toHaveAttribute('href', `/admin/videos/${video!.id}`)

    await edit.click()
    await page.waitForURL(`/admin/videos/${video!.id}`)
    await expect(page.getByRole('button', { name: 'Save details' })).toBeVisible()
  })

  /**
   * The moderation queue. Removal is the only power an admin has over someone
   * else's comment — the API refuses an edit even for them, because rewriting
   * someone's words and leaving their name on it is not moderation.
   */
  test('a comment can be removed from the moderation queue', async ({ page }) => {
    // Post one through the real UI so there is something to moderate, and so
    // the test does not depend on what a previous run left behind.
    const body = `Moderate me ${Date.now()}`
    // Comments live with the player, so posting one means getting there: a
    // video's page describes it, and Play opens the player. Somewhere in the
    // app first — a relative fetch has no base URL to resolve on about:blank.
    await visit(page, '/browse')
    const slug = await page.evaluate(async () => {
      const body = await (await fetch('/api/videos?limit=1')).json()
      return (body.items?.[0]?.slug ?? null) as string | null
    })
    await visit(page, `/v/${slug}`)
    await page.getByRole('link', { name: /^(Play|Resume)/ }).first().click()
    await page.waitForURL(/\/watch\//)
    await fillStable(page, 'textarea', body)
    await expectsRequest(page, /\/comments$/, 'POST', () =>
      page.getByRole('button', { name: 'Post' }).click())

    await visit(page, '/admin/comments')
    const row = page.locator('article').filter({ hasText: body })
    await expect(row).toHaveCount(1)

    await expectsRequest(page, /\/comments\//, 'DELETE', () =>
      row.getByRole('button', { name: /^Remove/ }).click())

    // Gone from the default view, because a tombstone is noise when you are
    // looking for something to act on.
    await expect(page.locator('article').filter({ hasText: body })).toHaveCount(0)

    // And still reachable, without its text, when asked for.
    await page.getByRole('checkbox', { name: 'Show removed' }).check()
    await expect(page.getByText('This comment was removed.').first()).toBeVisible()
    await expect(page.getByText(body)).toHaveCount(0)
  })

  test('minting an invite shows a token exactly once', async ({ page }) => {
    await visit(page, '/admin/users')

    await expectsRequest(page, /\/admin\/invites$/, 'POST', () =>
      page.getByRole('button', { name: 'Mint a token' }).click())

    await expect(page.getByText('Copy this now')).toBeVisible()
    const token = page.locator('code')
    await expect(token).toBeVisible()
    expect((await token.innerText()).length).toBeGreaterThan(20)

    // The same secret as something sendable. The link carries the token to
    // /setup, which prefills it — that pairing is asserted below.
    const link = page.getByRole('link', { name: /\/setup\?token=/ })
    await expect(link).toBeVisible()
    expect(await link.getAttribute('href')).toContain(`/setup?token=${await token.innerText()}`)

    // Held in memory only — a reload must not show it again.
    await page.reload()
    await expect(page.getByText('Copy this now')).toHaveCount(0)
    await expect(page.getByRole('link', { name: /\/setup\?token=/ })).toHaveCount(0)
  })

  test('clicking a column header sorts by it, and again reverses it', async ({ page }) => {
    await visit(page, '/admin/users')

    const table = page.getByRole('table', { name: 'Invites' })
    const kind = table.getByRole('columnheader', { name: 'Kind' })
    const kindCells = table.locator('tbody tr td:first-child')

    // The API sends newest-created first, and the page keeps that.
    await expect(table.getByRole('columnheader', { name: 'Created' }))
      .toHaveAttribute('aria-sort', 'descending')

    await kind.getByRole('button').click()
    await expect(kind).toHaveAttribute('aria-sort', 'ascending')
    const ascending = await kindCells.allInnerTexts()
    expect(ascending).toEqual([...ascending].sort())

    await kind.getByRole('button').click()
    await expect(kind).toHaveAttribute('aria-sort', 'descending')
    // Compared against the same values sorted the other way, not against the
    // reversed array: ties break on `id` ascending in *both* directions, so a
    // straight reversal is not what a descending sort produces.
    const descending = await kindCells.allInnerTexts()
    expect(descending).toEqual([...ascending].sort((a, b) => b.localeCompare(a)))

    // One column sorted at a time — the previous one goes back to neutral.
    await expect(table.getByRole('columnheader', { name: 'Created' }))
      .toHaveAttribute('aria-sort', 'none')
  })

  test('the invite table header stays put while the list scrolls', async ({ page }) => {
    await visit(page, '/admin/users')

    const scroller = page.locator('div', { has: page.getByRole('table', { name: 'Invites' }) }).last()
    const heading = page.getByRole('table', { name: 'Invites' }).getByRole('columnheader', { name: 'Kind' })

    const before = await heading.boundingBox()
    await scroller.evaluate(node => node.scrollBy(0, 400))
    // A header that scrolls away leaves the viewport; a sticky one does not
    // move at all, which is the difference worth asserting.
    await expect(async () => {
      const after = await heading.boundingBox()
      expect(after?.y).toBeCloseTo(before?.y ?? 0, 0)
    }).toPass()
  })

  test('the invite list names who minted a token and what state it is in', async ({ page }) => {
    await visit(page, '/admin/users')

    await expectsRequest(page, /\/admin\/invites$/, 'POST', () =>
      page.getByRole('button', { name: 'Mint a token' }).click())

    // Newest first (createdAt desc, id desc), so this run's mint is row one.
    const row = page.getByRole('table', { name: 'Invites' }).locator('tbody tr').first()

    await expect(row).toContainText('INVITE')
    await expect(row).toContainText('VALID')
    await expect(row).toContainText('expires')
    // The username rather than the display name: it is the unique one, and it
    // is the half that only arrives if the API's sub-select asked for it.
    await expect(row).toContainText(USERNAME)
  })

  test('revoking an invite asks first, and kills it on confirmation', async ({ page }) => {
    await visit(page, '/admin/users')

    // Non-default values, so the row proves the form actually sends them
    // rather than the API's own defaults happening to match.
    await page.getByRole('combobox', { name: 'How long the invite lasts' }).click()
    await page.getByRole('option', { name: '24 hours' }).click()
    await page.getByRole('combobox', { name: 'Role the invite grants' }).click()
    await page.getByRole('option', { name: 'Admin' }).click()

    await expectsRequest(page, /\/admin\/invites$/, 'POST', () =>
      page.getByRole('button', { name: 'Mint a token' }).click())

    const row = page.getByRole('table', { name: 'Invites' }).locator('tbody tr').first()
    await expect(row).toContainText('ADMIN')
    await expect(row).toContainText('VALID')

    // Backing out leaves the token live.
    await row.getByRole('button', { name: /^Revoke invite/ }).click()
    await expect(page.getByText('This invite can still be used')).toBeVisible()
    await page.getByRole('button', { name: 'Cancel' }).click()
    // A closing dialog's overlay still swallows pointer events, so the next
    // click lands on nothing and the request never fires.
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(row).toContainText('VALID')

    // Unlike the season delete, this one is safe to finish: it revokes a token
    // this test minted a moment ago and nothing leaves the disk.
    await row.getByRole('button', { name: /^Revoke invite/ }).click()
    await expectsRequest(page, /\/admin\/invites\//, 'DELETE', () =>
      page.getByRole('button', { name: 'Revoke this invite' }).click())

    await toast(page, 'Invite revoked')
    await expect(row).toContainText('REVOKED')
    await expect(row).toContainText('revoked')
    await expect(row.getByRole('button', { name: /^Revoke invite/ })).toHaveCount(0)
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

/**
 * The receiving end of an invite link.
 *
 * Signed out on purpose: `auth.global.ts` bounces an authenticated visitor off
 * `/setup` to the home page, so the shared `storageState` would never reach the
 * page under test.
 */
test.describe('redeeming by link', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('the token in the URL arrives in the form', async ({ page }) => {
    await visit(page, '/setup?token=not-a-real-token-just-a-string')

    await expect(page.getByRole('textbox', { name: 'Token' }))
      .toHaveValue('not-a-real-token-just-a-string')
  })

  test('the field is still empty and usable without a link', async ({ page }) => {
    await visit(page, '/setup')

    await expect(page.getByRole('textbox', { name: 'Token' })).toHaveValue('')
  })
})
