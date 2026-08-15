import { expect, expectsRequest, test, visit } from './fixtures'

/**
 * The account menu in the viewer header.
 *
 * It went untested until it had two bugs at once: the panel was centred under
 * an avatar at the far right of the bar, and opening it moved the page. Both
 * came from `UDropdownMenu` defaults nobody had passed a value for, which is
 * exactly the kind of fault a test that only checks the button exists walks
 * straight past.
 */

const trigger = (page: Parameters<typeof visit>[0]) =>
  page.getByRole('button', { name: 'Your account' })

test.describe('the account menu', () => {
  test('opens with its right edge on the avatar, not centred under it', async ({ page }) => {
    await visit(page, '/')

    const button = trigger(page)
    await button.click()

    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()

    const t = (await button.boundingBox())!
    const m = (await menu.boundingBox())!

    /*
     * The whole point of `align: 'end'`. Centred, the panel is far wider than
     * the avatar and overhangs it on both sides, so this difference was about
     * half the panel's width. A pixel of tolerance covers subpixel layout.
     */
    expect(Math.abs((m.x + m.width) - (t.x + t.width))).toBeLessThanOrEqual(1)

    // And it sits below the trigger rather than over it.
    expect(m.y).toBeGreaterThanOrEqual(t.y + t.height)
  })

  test('never locks the body, so the page cannot shift', async ({ page }) => {
    await visit(page, '/')

    const body = () =>
      page.evaluate(() => ({
        overflow: document.body.style.overflow,
        paddingRight: document.body.style.paddingRight,
        marginRight: document.body.style.marginRight,
      }))

    expect(await body()).toEqual({ overflow: '', paddingRight: '', marginRight: '' })

    await trigger(page).click()
    await expect(page.getByRole('menu')).toBeVisible()

    /*
     * This asserts the *mechanism*, not the shift, and deliberately so.
     *
     * Reka's scroll lock only pads the body when there is a real scrollbar to
     * stand in for (`if (verticalScrollbarWidth > 0)`), and headless Chromium
     * uses overlay scrollbars of width 0 — the same reason `main.css` notes the
     * reserved gutter is invisible here. So a test that measured the header's
     * box before and after would pass against the broken code too, and report
     * green on the bug it was written for.
     *
     * `modal: false` means the lock is never engaged at all, whatever the
     * scrollbar is doing, and that does hold in this browser.
     */
    expect(await body()).toEqual({ overflow: '', paddingRight: '', marginRight: '' })
  })

  /**
   * History is reached from here and nowhere else in the shell.
   *
   * Both halves matter. A menu entry that renders but navigates nowhere leaves
   * the page unreachable now that the header link is gone, and a header link
   * left behind would mean the move never happened — neither shows up in a
   * test that only opens the menu and looks at it.
   */
  test('is the way to History, which has left the header', async ({ page }) => {
    await visit(page, '/')

    await expect(
      page.locator('header nav').getByRole('link', { name: 'History', exact: true }),
    ).toHaveCount(0)

    await trigger(page).click()

    const item = page.getByRole('menuitem', { name: 'History' })
    await expect(item).toBeVisible()

    await item.click()
    await page.waitForURL('**/history')
    await expect(page.getByRole('heading', { name: 'History', level: 1 })).toBeVisible()
  })

  test('names the signed-in user', async ({ page }) => {
    await visit(page, '/')

    const me = await page.evaluate(
      async () => (await (await fetch('/api/auth/me')).json()) as { displayName: string, role: string },
    )

    await trigger(page).click()
    const menu = page.getByRole('menu')
    await expect(menu).toContainText(me.displayName)
    await expect(menu).toContainText(me.role === 'ADMIN' ? 'Admin' : 'Member')
  })

  /**
   * Sign out reaches the API and lands on the sign-in page.
   *
   * The session is simulated rather than really destroyed, because this suite
   * signs in **once** and shares that cookie with every test after this one — a
   * genuine logout here would 401 the rest of the run.
   *
   * Simulating it takes *both* stubs, and that is the part worth writing down.
   * Stubbing only `/auth/logout` looks sufficient and is a trap: `signOut`
   * clears the client's `user` and navigates to `/login`, where
   * `auth.global.ts` re-reads `/auth/me` — still answering "signed in", since
   * the server never heard about the logout — and bounces straight back to `/`.
   * That fails against an app behaving perfectly. A logout is two facts, and
   * the second one is what the middleware actually reads.
   */
  test('signs the viewer out', async ({ page }) => {
    await visit(page, '/')

    await page.route('**/api/auth/logout', route => route.fulfill({ status: 204 }))
    await page.route('**/api/auth/me', route =>
      route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }))

    await expectsRequest(page, /\/api\/auth\/logout/, 'POST', async () => {
      await trigger(page).click()
      await page.getByRole('menuitem', { name: 'Sign out' }).click()
    })

    await page.waitForURL(/\/login/)
    await expect(page.locator('input[autocomplete="username"]')).toBeVisible()
  })

  test('closes on Escape and returns focus to the avatar', async ({ page }) => {
    await visit(page, '/')

    const button = trigger(page)
    await button.click()
    await expect(page.getByRole('menu')).toBeVisible()

    /*
     * Non-modal content keeps Escape and click-outside — they come from the
     * shared DismissableLayer, not from the modal path — and this is what says
     * so. Losing them while chasing the scroll lock would be a poor trade.
     */
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(button).toBeFocused()
  })
})
