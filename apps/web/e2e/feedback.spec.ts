// apps/web/e2e/feedback.spec.ts
import { expect, expectsRequest, test, toast, visit } from './fixtures'

/**
 * The floating feedback button and its dialog.
 *
 * Submission is asserted through `expectsRequest` — a button that renders
 * perfectly and never calls the API looks identical from the outside. Text
 * only: html2canvas's own behaviour is exercised by hand, not here.
 */
test.describe('feedback', () => {
  test('is available on an ordinary page and absent on login', async ({ page }) => {
    await visit(page, '/')
    await expect(page.getByRole('button', { name: 'Send feedback' })).toBeVisible()

    await page.context().clearCookies()
    await page.goto('/login')
    await expect(page.getByRole('button', { name: 'Send feedback' })).not.toBeVisible()
  })

  test('submitting sends a message and closes the dialog', async ({ page }) => {
    await visit(page, '/')
    await page.getByRole('button', { name: 'Send feedback' }).click()

    await page.getByLabel('Feedback message').fill('The button overlaps the footer on this page.')

    await expectsRequest(page, /\/api\/feedback$/, 'POST', async () => {
      await page.getByRole('button', { name: 'Send' }).click()
    })

    await expect(toast(page, /feedback sent/i)).toBeVisible()
    await expect(page.getByRole('dialog')).not.toBeVisible()
  })

  test('clicking outside the dialog dismisses it', async ({ page }) => {
    await visit(page, '/')
    await page.getByRole('button', { name: 'Send feedback' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()

    // Click somewhere the overlay covers but the dialog content does not.
    await page.mouse.click(5, 5)

    await expect(page.getByRole('dialog')).not.toBeVisible()
  })

  test('is reachable from the admin sidebar', async ({ page }) => {
    await visit(page, '/admin')

    await page.getByRole('link', { name: 'Feedback' }).first().click()
    await page.waitForURL('**/admin/feedback')

    await expect(page.getByRole('heading', { name: 'Feedback', level: 1 })).toBeVisible()
  })
})
