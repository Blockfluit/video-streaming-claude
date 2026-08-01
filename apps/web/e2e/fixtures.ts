import { expect, test as base, type Page } from '@playwright/test'

/**
 * Shared setup: a signed-in admin, and a console watchdog.
 *
 * The watchdog is the point of these tests as much as the assertions are. A
 * Vue component that throws during hydration leaves the server-rendered markup
 * on screen, so the page still *looks* right and every locator still finds its
 * element — while nothing on it responds to a click. Failing the test on an
 * unexpected console error is what catches that.
 */
export const USERNAME = process.env.E2E_USERNAME ?? 'ada'
export const PASSWORD = process.env.E2E_PASSWORD ?? 'correct horse battery staple'

/**
 * Requests whose failure says nothing about the page under test.
 *
 * Matched on the URL from the **response**, not the console text: Chromium logs
 * a failed request as "Failed to load resource: … 401" with no URL in it, so
 * filtering on the message either ignores everything or nothing.
 */
const ALWAYS_ALLOWED = [
  // Every page load probes this before deciding whether to redirect; a 401 is
  // the ordinary answer for a signed-out visitor.
  '/api/auth/me',
]

const allowances = new WeakMap<object, RegExp[]>()

/**
 * Tells the watchdog that this test means to provoke a rejection.
 *
 * Some of the most valuable behaviour here is an endpoint *refusing*: the last
 * admin cannot be demoted, an SRT cannot masquerade as a WebVTT. Those come back
 * 4xx by design, and the test that exercises one says so — rather than the suite
 * quietly ignoring every 4xx everywhere and missing a real one.
 */
export function expectApiRejection(page: object, pattern: RegExp): void {
  allowances.set(page, [...(allowances.get(page) ?? []), pattern])
}

/**
 * Hosts the trailer hero embeds from.
 *
 * Blocked in every test. Two reasons, and both would otherwise be blamed on
 * the app: a real embed emits its own telemetry requests, some of which answer
 * 4xx and would trip the watchdog below on every page carrying a hero; and a
 * streaming trailer keeps the network busy indefinitely, so `visit()`'s
 * `networkidle` would never settle and every navigation would time out.
 *
 * Fulfilled rather than aborted, so no failed request exists to notice. What
 * the tests assert is the `<iframe src>` — which is ours — rather than whether
 * Google chose to play something.
 */
const THIRD_PARTY_MEDIA = [
  '**://*.youtube-nocookie.com/**',
  '**://*.youtube.com/**',
  '**://*.googlevideo.com/**',
  '**://*.ytimg.com/**',
]

export const test = base.extend<{ failOnConsoleError: void }>({
  failOnConsoleError: [
    async ({ page, baseURL }, use) => {
      const problems: string[] = []

      for (const pattern of THIRD_PARTY_MEDIA) {
        await page.route(pattern, route =>
          route.fulfill({ status: 200, contentType: 'text/html', body: '' }),
        )
      }

      // A JS exception is always a failure: it is what a component throwing
      // during hydration looks like, and it leaves the server-rendered markup
      // on screen — so the page still looks right while nothing responds.
      page.on('pageerror', error => problems.push(`pageerror: ${error.message}`))

      page.on('response', (response) => {
        if (response.status() < 400) return
        const url = response.url()
        // Only our own responses say anything about our own app. A third party
        // answering 4xx is their business, and letting it fail a test here
        // makes the suite depend on someone else's uptime.
        if (baseURL && !url.startsWith(baseURL)) return
        if (ALWAYS_ALLOWED.some(allowed => url.includes(allowed))) return
        if ((allowances.get(page) ?? []).some(pattern => pattern.test(url))) return
        problems.push(`${response.status()} ${url}`)
      })

      await use()

      expect(problems, `unexpected failures:\n${problems.join('\n')}`).toEqual([])
    },
    { auto: true },
  ],
})

/**
 * The visible half of a toast.
 *
 * @nuxt/ui renders every notification twice — once in an `aria-live` region for
 * screen readers, once on screen — so matching the text alone is ambiguous.
 */
export function toast(page: Page, text: string | RegExp) {
  return page.locator('[data-slot="title"]').filter({ hasText: text })
}

/**
 * Types into a field and makes sure the value survived.
 *
 * Server-rendered markup is interactive-looking long before Vue hydrates, and
 * filling an input in that window is silently undone: hydration replaces the
 * DOM value with the (empty) model. Retrying is not flake-hiding — it is
 * waiting for the app to actually be alive.
 */
export async function fillStable(page: Page, selector: string, value: string): Promise<void> {
  const field = page.locator(selector)
  await expect(field).toBeVisible()

  await expect(async () => {
    await field.fill(value)
    await expect(field).toHaveValue(value, { timeout: 1000 })
  }).toPass({ timeout: 15_000 })
}

/**
 * Signs in, retrying the whole form.
 *
 * The same hydration window that eats a `fill` also eats the `click`: the
 * button exists in the server-rendered HTML before Vue has attached a submit
 * handler to it, so an early click does nothing at all and leaves the page
 * sitting on `/login` looking perfectly normal.
 */
export async function signIn(page: Page): Promise<void> {
  await page.goto('/login')

  await expect(async () => {
    await fillStable(page, 'input[autocomplete="username"]', USERNAME)
    await fillStable(page, 'input[type="password"]', PASSWORD)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.waitForURL('/', { timeout: 5000 })
  }).toPass({ timeout: 40_000 })

  await page.waitForLoadState('networkidle')
}

/**
 * Navigates and waits for the app to be interactive.
 *
 * Every `goto` in these tests goes through here. Server-rendered markup accepts
 * a click or a keystroke long before Vue has attached anything to it, and the
 * interaction is then silently dropped — which looks exactly like a broken
 * button.
 */
export async function visit(page: Page, path: string): Promise<void> {
  await page.goto(path)
  await page.waitForLoadState('networkidle')
}

/**
 * Runs an action and asserts it actually reached the API.
 *
 * This is what separates "the button is there" from "the button works". A
 * handler that silently does nothing passes every other kind of check.
 */
export async function expectsRequest(
  page: Page,
  urlPattern: RegExp,
  method: string,
  action: () => Promise<void>,
): Promise<void> {
  const waiting = page.waitForRequest(
    request => urlPattern.test(request.url()) && request.method() === method,
    { timeout: 10_000 },
  )
  await action()
  await waiting
}

/**
 * Removes a season **and its folder**.
 *
 * Creating a season creates a directory under MEDIA_ROOT, and deleting the row
 * alone leaves it there — reconcile then rebuilds the row on the next scan, and
 * this suite runs a scan. A test that tidies up with the UI's own Remove button
 * therefore leaves a season that reappears part-way through the run and shifts
 * the page under whatever comes next. The UI deliberately does not offer
 * `deleteFiles`, because for a real admin the recoverable mistake is the right
 * default; a test is the one caller that wants the other one.
 */
export async function removeSeasonWithFolder(page: Page, number: number): Promise<void> {
  await page.evaluate(async (seasonNumber) => {
    const collections = await (await fetch('/api/collections?limit=1')).json()
    const collection = collections.items?.[0]
    if (!collection) return

    const find = async () => {
      const detail = await (await fetch(`/api/collections/${collection.slug}`)).json()
      return (detail.seasons ?? []).find(
        (candidate: { number: number | null }) => candidate.number === seasonNumber,
      )
    }

    /*
     * The row may already be gone — a test that exercised the UI's own Remove
     * button deleted it, and that button deliberately keeps the folder. The
     * folder is the thing that has to go, and the only way to reach it is
     * through a season row, so one is recreated over the same folder purely to
     * delete it properly.
     */
    let season = await find()
    if (!season) {
      await fetch('/api/seasons', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collectionId: collection.id, number: seasonNumber }),
      })
      season = await find()
    }

    if (season) await fetch(`/api/seasons/${season.id}?deleteFiles=true`, { method: 'DELETE' })
  }, number)
}

export { expect }
