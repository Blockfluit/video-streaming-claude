import { expect, test, visit } from './fixtures'

/**
 * The shape of the sign-in form, pinned.
 *
 * `auth.setup.ts` signs in once for the whole run through three selectors —
 * `input[autocomplete="username"]`, `input[type="password"]`, and a button
 * named "Sign in" — and every other spec in this project depends on that
 * session. Break any one of them and the failure is a hundred unrelated tests
 * timing out, with nothing pointing at the form that caused it.
 *
 * The one that can break silently is **uniqueness**. A second password box on
 * this page — the confirmation added to `/setup`, pasted here by someone
 * reasonably assuming both auth screens should match — resolves to two elements
 * and turns every `fill` into a strict-mode violation. That is a one-line
 * change with no visible symptom on the page itself.
 *
 * Signed out, because `auth.global.ts` bounces an authenticated visitor to the
 * home page before any of this renders.
 */
test.describe('the sign-in form', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  test('offers exactly the controls the whole suite signs in through', async ({ page }) => {
    await visit(page, '/login')

    await expect(page.locator('input[autocomplete="username"]')).toHaveCount(1)
    // Exactly one. Two is the mistake this test exists for.
    await expect(page.locator('input[type="password"]')).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeEnabled()
  })

  test('asks for the password once — confirming belongs on signup', async ({ page }) => {
    await visit(page, '/login')

    // Confirming a password you are typing from memory checks nothing: the
    // server already knows whether it is right, and says so immediately.
    await expect(page.locator('input[name="confirmPassword"]')).toHaveCount(0)
  })

  test('the way to redeem an invite is reachable from here', async ({ page }) => {
    await visit(page, '/login')

    /*
     * Retried, like the sign-in helper. The anchor is in the server-rendered
     * markup and accepts a click before Vue has hydrated, and that click is
     * then swallowed — the page simply stays where it is, looking entirely
     * normal. Waiting for `networkidle` does not cover it, which is why `visit`
     * alone is not enough here.
     */
    await expect(async () => {
      await page.getByRole('link', { name: 'Redeem it here.' }).click()
      await page.waitForURL('**/setup', { timeout: 5000 })
    }).toPass({ timeout: 30_000 })

    await expect(page.getByRole('button', { name: 'Create account' })).toBeVisible()
  })
})
