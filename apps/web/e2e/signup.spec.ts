import { expect, fillStable, test, visit } from './fixtures'

/**
 * The signup form's password confirmation.
 *
 * Worth its own file because this is the one form in the app whose mistakes
 * cannot be undone. The library sends no mail and has no reset flow, so a
 * mistyped password is a permanently unreachable account, and the only remedy
 * is an admin minting a fresh invite. The second field exists to catch that,
 * and a second field that does not actually block a submit is worse than none —
 * it looks like a safety net while being decoration.
 *
 * Signed out, because `auth.global.ts` bounces an authenticated visitor off
 * `/setup` before any of this renders.
 */
test.describe('creating an account', () => {
  test.use({ storageState: { cookies: [], origins: [] } })

  /** Long enough to satisfy the length rule, so only the match is in question. */
  const LONG = 'correct horse battery staple'

  /*
   * Addressed by `name`, not by `autocomplete`. Both boxes are legitimately
   * `autocomplete="new-password"` — that is what tells a password manager to
   * offer one suggestion for the pair rather than to autofill the old
   * credential — so that selector matches two elements and every `fill` through
   * it is a strict-mode violation. The names are what tell them apart.
   */
  const PASSWORD = 'input[name="password"]'
  const CONFIRM = 'input[name="confirmPassword"]'

  test('the form asks for the password twice', async ({ page }) => {
    await visit(page, '/setup')
    // Two boxes, not one. The rest of this file is meaningless if the second
    // one is not on the page.
    await expect(page.locator('input[type="password"]')).toHaveCount(2)
  })

  test('a mismatch is refused, and says so', async ({ page }) => {
    await visit(page, '/setup')

    await fillStable(page, 'input[autocomplete="username"]', 'someone-new')
    await fillStable(page, PASSWORD, LONG)
    await fillStable(page, CONFIRM, `${LONG}-typo`)

    /*
     * A request here would mean the confirmation is cosmetic and the account
     * gets created with whichever value the first box happened to hold. Watched
     * rather than assumed: the submit is genuinely attempted, and the assertion
     * is that nothing left the browser.
     */
    let posted = false
    page.on('request', (request) => {
      if (request.url().includes('/api/auth/redeem')) posted = true
    })

    await page.getByRole('button', { name: 'Create account' }).click()

    await expect(page.getByText('Passwords do not match.')).toBeVisible()
    expect(posted, 'a mismatched password reached /auth/redeem').toBe(false)
    await expect(page).toHaveURL(/\/setup$/)
  })

  test('the checklist answers as the fields are filled', async ({ page }) => {
    await visit(page, '/setup')

    // Both rules are on screen from the start — they are what the form is
    // asking for, so they cannot wait until after a mistake to appear.
    await expect(page.getByText('At least 12 characters')).toBeVisible()
    await expect(page.getByText('Passwords match')).toBeVisible()

    /*
     * The states are read through the accessible text rather than the icon or
     * the colour. That is the same reason it is written that way: an icon is a
     * mask-image with no text of its own, so a checklist that only draws its
     * answer says nothing to a screen reader — and nothing to this test either.
     */
    const lengthRule = page.locator('li', { hasText: 'At least 12 characters' })
    const matchRule = page.locator('li', { hasText: 'Passwords match' })

    await expect(lengthRule).toContainText('Required:')
    await expect(matchRule).toContainText('Required:')

    await fillStable(page, PASSWORD, 'short')
    await expect(lengthRule).toContainText('Not yet:')

    await fillStable(page, PASSWORD, LONG)
    await expect(lengthRule).toContainText('Done:')
    // Still untouched, so still a request rather than a complaint.
    await expect(matchRule).toContainText('Required:')

    await fillStable(page, CONFIRM, `${LONG}-typo`)
    await expect(matchRule).toContainText('Not yet:')

    await fillStable(page, CONFIRM, LONG)
    await expect(matchRule).toContainText('Done:')
  })

  test('an invite link fills the token in and keeps it reachable', async ({ page }) => {
    await visit(page, '/setup?token=an-invite-token')

    // Collapsed, because the question is already answered — 43 characters of
    // base64 is not something anyone reads and checks.
    await expect(page.getByText('Token applied from your link.')).toBeVisible()

    // But a link can carry a stale or wrong token, and a filled-in field nobody
    // can get at is a dead end.
    await page.getByRole('button', { name: 'Change' }).click()
    // Found by its label, which is also the assertion that the field has one.
    await expect(page.getByLabel('Token')).toBeVisible()
    await expect(page.getByLabel('Token')).toHaveValue('an-invite-token')
  })
})
