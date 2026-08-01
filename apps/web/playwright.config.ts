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
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
