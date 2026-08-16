import { expect, test, visit } from './fixtures'
import { AUDIT } from './audit'

/**
 * The phone project's own tests.
 *
 * Everything here runs only at 375×812 with touch emulation on — see the
 * `phone` project in `playwright.config.ts`, and the matching `testIgnore` on
 * `chromium` that keeps these off the desktop run, where a `lg:hidden` control
 * is `display: none` and every assertion below would fail against working code.
 *
 * The rest of the suite is deliberately *not* repeated here. It asserts
 * behaviour — requests fired, toasts shown, jobs progressing — and behaviour
 * does not change with the viewport, so a second serial pass over it would buy
 * duplicated coverage at roughly the cost of the first one.
 */

test.describe('the phone viewport itself', () => {

  /*
   * The one test that guards the config rather than the app.
   *
   * `hasTouch` is what flips `(pointer: coarse)`, and every touch-specific rule
   * in `main.css` hangs off that media query. If this project ever loses the
   * flag the rules stop being exercised — and nothing else in the suite would
   * notice, because the CSS still parses and the pages still render.
   */
  test('emulates a phone, coarse pointer and all', async ({ page }) => {
    await visit(page, '/')

    const environment = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      coarse: matchMedia('(pointer: coarse)').matches,
      hover: matchMedia('(hover: hover)').matches,
    }))

    expect(environment.width).toBe(375)
    expect(environment.coarse).toBe(true)
    expect(environment.hover).toBe(false)
  })

  /*
   * The ruler measures — proved on something known to be too wide, rather than
   * inferred from a green run.
   *
   * An audit that quietly reports nothing looks exactly like an app with
   * nothing wrong with it, and this suite has been bitten by that before: a
   * skip that never ran reported green for months. So put a box on the page
   * that cannot fit, and check the audit names it.
   */
  test('the overflow check finds a box that does not fit', async ({ page }) => {
    await visit(page, '/')

    const named = (problems: { kind: string, detail: string }[]) =>
      problems.filter(p => p.detail.includes('overflow-probe'))

    const planted = await page.evaluate(`(() => {
      const probe = document.createElement('div')
      probe.className = 'overflow-probe'
      probe.style.cssText = 'width:2000px;height:20px'
      document.body.append(probe)
      return null
    })()`)
    expect(planted).toBeNull()

    const withProbe = await page.evaluate(AUDIT)
    expect(withProbe.some((p: { kind: string }) => p.kind === 'page-overflow')).toBe(true)
    expect(named(withProbe)).toHaveLength(1)
    expect(named(withProbe)[0].kind).toBe('overflows-viewport')

    // And stops naming it the moment it is gone, so the finding tracks the page
    // rather than being something the audit says about every run.
    await page.evaluate(`document.querySelector('.overflow-probe').remove()`)
    expect(named(await page.evaluate(AUDIT))).toHaveLength(0)
  })
})

test.describe('the nav drawer', () => {

  /*
   * The bug this replaced: the header packed a wordmark, five links and the
   * account trigger into one unwrapped row, and the trigger — last in the
   * flex — was what went off the right edge. Signing out was not awkward on a
   * phone, it was unreachable. So this asserts the trigger is *there* as much
   * as it asserts the drawer opens.
   */
  test('opens the destinations the bar cannot hold, and keeps the account reachable', async ({ page }) => {
    await visit(page, '/')

    await expect(page.getByRole('button', { name: 'Your account' })).toBeVisible()

    await page.getByRole('button', { name: 'Menu' }).click()
    const drawer = page.getByRole('dialog')
    await expect(drawer).toBeVisible()
    await expect(drawer.getByRole('link', { name: 'Browse' })).toBeVisible()
  })

  test('closes when a link takes you somewhere', async ({ page }) => {
    await visit(page, '/')
    await page.getByRole('button', { name: 'Menu' }).click()

    await page.getByRole('dialog').getByRole('link', { name: 'Browse' }).click()

    await expect(page).toHaveURL(/\/browse$/)
    await expect(page.getByRole('dialog')).toBeHidden()
  })

  test('closes on Escape', async ({ page }) => {
    await visit(page, '/')
    await page.getByRole('button', { name: 'Menu' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()

    await page.keyboard.press('Escape')

    await expect(page.getByRole('dialog')).toBeHidden()
  })

  /*
   * Audited with the panel open, because nothing else can reach it: the audit
   * skips `display: none`, and the drawer is both behind a breakpoint and
   * behind an interaction. Reka unmounts it when hidden, so a closed drawer is
   * not merely invisible to the walk — it is not in the document at all.
   */
  test('has nothing unreadable or invisible in it', async ({ page }) => {
    await visit(page, '/')
    await page.getByRole('button', { name: 'Menu' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()

    const problems = await page.evaluate(AUDIT)
    expect(
      problems,
      `nav drawer:\n${problems.map((p: { kind: string, value: number, detail: string }) =>
        `  ${p.kind} (${p.value}) — ${p.detail}`).join('\n')}`,
    ).toEqual([])
  })
})

test.describe('the poster wall', () => {

  /*
   * Two columns, not one.
   *
   * `auto-fill` with an 11rem floor needs a 400px viewport to find room for a
   * second track, so every phone narrower than that was served one poster per
   * row at the full width of the screen — a wall of one title. The override is
   * counted here rather than eyeballed, because the failure looks like a
   * design choice in a screenshot.
   */
  test('is two columns wide on a phone', async ({ page }) => {
    await visit(page, '/browse')

    const grid = page.locator('.poster-grid').first()
    await expect(grid).toBeVisible()

    const columns = await grid.evaluate(el =>
      getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length)

    expect(columns).toBe(2)
  })
})
