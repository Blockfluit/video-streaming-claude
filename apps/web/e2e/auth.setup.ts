import { expect, test as setup } from '@playwright/test'

import { PASSWORD, USERNAME } from './fixtures'

/**
 * Signs in once for the whole run and saves the cookie.
 *
 * Every spec used to log in per test — around fifty logins in seven minutes,
 * from one address, with the sign-in helper retrying the whole form whenever
 * hydration ate a keystroke. That is far more than a person ever does, and once
 * `/auth/login` gained a rate limit it started returning 429 part-way through
 * the run.
 *
 * Raising the limit to accommodate the suite would have been the wrong fix: ten
 * a minute is right for the one route an outsider can reach, and the test doing
 * something no user does is the part that was wrong. Reusing a session is also
 * what a real browser does, and it takes a minute off the run.
 */
const STATE = 'e2e/.auth/state.json'

setup('sign in once', async ({ page }) => {
  await page.goto('/login')

  // The same retry the old helper needed: server-rendered markup accepts a
  // keystroke before Vue hydrates, and that input is silently discarded.
  await expect(async () => {
    await page.fill('input[autocomplete="username"]', USERNAME)
    await page.fill('input[type="password"]', PASSWORD)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.waitForURL('/', { timeout: 5000 })
  }).toPass({ timeout: 40_000 })

  await page.context().storageState({ path: STATE })
})
