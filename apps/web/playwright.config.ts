import { defineConfig, devices } from '@playwright/test'

/**
 * Browser tests against a running app.
 *
 * These exist because the two worst bugs in this frontend so far — a CommonJS
 * package the browser could not import, and an icon endpoint the API proxy
 * swallowed — both returned a clean HTTP 200 to `curl`. Server-rendered HTML
 * proves the server rendered. It says nothing about whether the page works.
 *
 * They assert that things *do something*, not that they exist: a button with no
 * handler renders perfectly.
 *
 * Requires the API on :4000 and Nuxt on :3000, and a database with the
 * bootstrap admin from `E2E_USERNAME` / `E2E_PASSWORD`. On WSL, headless
 * Chromium needs system libraries — `npx playwright install --with-deps
 * chromium`, or point `LD_LIBRARY_PATH` at locally extracted ones.
 */
export default defineConfig({
  testDir: './e2e',
  // Serial: the tests share one library and several of them write to it.
  workers: 1,
  fullyParallel: false,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? 'github' : [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    /*
     * The whole suite asks for reduced motion, and the home hero is why.
     *
     * It auto-plays a trailer and rotates, which would put a third-party
     * YouTube iframe on `/` — a page a dozen tests visit only to get a base URL
     * for a `fetch`. The watchdog below fails any response ≥400 in *any* frame,
     * so somebody else's beacon returning a 4xx would fail an unrelated test,
     * `visit`'s `networkidle` would race the iframe, and the run would need
     * outbound internet to be green.
     *
     * `HeroBackdrop` already honours this setting, so asking for it here keeps
     * every existing test deterministic and offline. The auto-play path is
     * covered deliberately instead — see `hero.spec.ts`, which opts back out
     * and stubs YouTube rather than reaching it.
     */
    reducedMotion: 'reduce',
  },
  projects: [
    /*
     * One sign-in for the whole run, saved and reused.
     *
     * Logging in per test meant about fifty logins in seven minutes from one
     * address — far more than a person ever does — and once `/auth/login` gained
     * a rate limit that started returning 429 mid-run. Reusing a session is what
     * a real browser does anyway, and it is quicker.
     */
    { name: 'setup', testMatch: /auth\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: 'e2e/.auth/state.json' },
      dependencies: ['setup'],
    },
  ],
})
