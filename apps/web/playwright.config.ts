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
      // The phone project's own specs, at 1280px, would be testing a drawer
      // whose trigger is `lg:hidden` — every one of them fails against code
      // that is working.
      testIgnore: /mobile\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'e2e/.auth/state.json',
        /*
         * A browser that trusts this origin, which is the one the player is for.
         *
         * Chrome allows an unmuted `play()` it saw no click for only once the
         * origin has earned an engagement score, and a fresh profile — which is
         * what every run gets — has none. Playwright does not pass this switch
         * itself (checked against its own list, 1.62), so without it the player
         * is refused here and only here, and a test asserting that playback
         * starts fails against code that is working.
         *
         * The refusal path is not lost by setting it: it is `play()` rejecting,
         * which the player already handles by leaving the poster and the
         * controls exactly where they were.
         */
        launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
      },
      dependencies: ['setup'],
    },
    /*
     * The same app at the width it is actually watched on.
     *
     * `hasTouch` is load-bearing rather than decoration: without it Chromium
     * reports `pointer: fine`, and every `@media (pointer: coarse)` rule in
     * `main.css` — the 44px targets, the longer start-over sweep, the disabled
     * card lift — is never exercised. A green run would say nothing about the
     * device the rules exist for.
     *
     * Not a device preset. `devices['iPhone 14']` implies WebKit, which is the
     * wrong browser and carries neither the storage state nor the autoplay
     * switch; spelling the viewport out keeps the two settings that matter at
     * the call site.
     *
     * One width, not three. `workers: 1` makes each extra width a full serial
     * pass, and 375 is the floor — what survives it survives the band.
     */
    {
      name: 'phone',
      testMatch: /mobile\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 375, height: 812 },
        hasTouch: true,
        isMobile: true,
        storageState: 'e2e/.auth/state.json',
        launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] },
      },
      dependencies: ['setup'],
    },
  ],
})
