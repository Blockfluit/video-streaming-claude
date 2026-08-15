import { expect } from '@playwright/test'

import { test, visit } from './fixtures'

/**
 * That a page paints *before* its data arrives.
 *
 * This is the one property of the whole change that rots invisibly. Every other
 * test here waits for the network to go quiet, by which point the placeholders
 * have been replaced by the real thing — so a skeleton that never rendered at
 * all, or one stranded behind a `status === 'pending'` test that is false on the
 * frame it is needed, would leave the entire suite green. The same trap as the
 * `locator.count()` guard that skipped itself for months.
 *
 * The response is held open deliberately rather than merely throttled. A
 * placeholder that has to be caught in a race is a flaky test; one that cannot
 * disappear until this test lets it is a decision.
 */
test.describe('loading placeholders', () => {
  test('browse paints its poster grid before the library answers', async ({ page }) => {
    // Land somewhere else first. The skeletons are for client-side navigation:
    // a hard load is server-rendered with the content already in the HTML,
    // which is the whole reason `lazy` is safe here.
    await visit(page, '/')

    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })

    // A predicate, not a glob. `**/api/library?**` reads as "the library with a
    // query string" and is not: Playwright's glob treats `?` as a single-
    // character wildcard, so it also swallows `/api/library/genres`, and the
    // page would then be waiting on two requests while the test thinks it is
    // holding one.
    await page.route(url => url.pathname === '/api/library', async (route) => {
      await held
      await route.continue()
    })

    // Not awaited: the click cannot settle until the route above is released,
    // and the assertion in between is the entire point.
    const navigated = page.locator('header').getByRole('link', { name: 'Browse' }).click()

    const placeholder = page.getByRole('status', { name: 'Loading the library' })
    await expect(placeholder).toBeVisible()

    release()
    await navigated

    // And it gets out of the way once the cards land.
    await expect(placeholder).toBeHidden()
    await expect(page.locator('main .poster-grid, .poster-grid').first()).toBeVisible()
  })

  /**
   * The half that is easy to get backwards.
   *
   * Ordering the placeholder *before* the empty state is what stops a page that
   * has not answered yet from announcing an empty library — and the page most
   * able to make that mistake is the one whose empty state is a full screen of
   * its own.
   */
  test('the home page does not claim to be empty while it is still loading', async ({ page }) => {
    await visit(page, '/browse')

    let release: () => void = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })

    await page.route(url => url.pathname === '/api/lists', async (route) => {
      await held
      await route.continue()
    })

    const navigated = page.locator('header').getByRole('link', { name: 'Home' }).click()

    await expect(page.getByRole('status', { name: 'Loading the library' })).toBeVisible()
    await expect(page.getByText('Nothing here yet')).toBeHidden()

    release()
    await navigated
  })
})
