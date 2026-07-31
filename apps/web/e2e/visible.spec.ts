import { expect, signIn, test, visit } from './fixtures'

/**
 * Two kinds of bug that every other test in this suite walks straight past.
 *
 * **Invisible controls.** Playwright happily clicks an element at `opacity: 0`,
 * and `toBeVisible()` does not check opacity either — so a button whose reveal
 * depends on a `group-hover` that no ancestor provides passes every functional
 * test while being, to a person, simply not there. That shipped here once.
 *
 * **Unreadable text.** A dark theme makes it easy to land on grey-on-black that
 * technically renders. Contrast is arithmetic, so it can just be measured.
 */

/** WCAG AA: 4.5:1 for body text, 3:1 for large. */
const AUDIT = `(() => {
  // Colours are resolved by painting them, because Chromium returns modern
  // colour spaces — oklab(), color() — for anything from the Tailwind palette,
  // and parsing those by hand gets the luminance silently wrong.
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const ctx = canvas.getContext('2d', { willReadFrequently: true })

  const paint = (colours) => {
    ctx.clearRect(0, 0, 1, 1)
    for (const colour of colours) {
      ctx.fillStyle = colour
      ctx.fillRect(0, 0, 1, 1)
    }
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
    return [r, g, b]
  }

  const luminance = ([r, g, b]) => {
    const channel = (value) => {
      const v = value / 255
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
  }

  const contrast = (a, b) => {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
    return (high + 0.05) / (low + 0.05)
  }

  // The stack of backgrounds behind an element, nearest last, so painting them
  // in order reproduces what the eye actually sees through the alpha.
  const backdrop = (el) => {
    const layers = []
    for (let node = el; node; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (style.backgroundImage !== 'none') return null // a gradient or photo
      layers.unshift(style.backgroundColor)
    }
    return ['#08080a', ...layers]
  }

  const problems = []
  const OPAQUE_ENOUGH = 0.35

  for (const el of document.querySelectorAll('main *, header *, aside *')) {
    const text = (el.textContent || '').trim()
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') continue

    // Effective opacity, which is what actually decides whether it is there.
    let opacity = 1
    for (let node = el; node; node = node.parentElement) {
      opacity *= Number(getComputedStyle(node).opacity)
    }

    const interactive = el.matches('button, a[href], input, select, textarea')
    if (interactive && opacity < OPAQUE_ENOUGH && el.offsetParent !== null) {
      problems.push({
        kind: 'invisible-control',
        detail: (el.getAttribute('aria-label') || text || el.tagName).slice(0, 50),
        value: Number(opacity.toFixed(2)),
      })
      continue
    }

    // Leaf text only: a container's textContent is its children's.
    if (!text || el.children.length > 0 || text.length > 80) continue
    if (opacity < 0.99) continue

    const layers = backdrop(el)
    if (!layers) continue

    const background = paint(layers)
    const foreground = paint([...layers, style.color])
    const ratio = contrast(foreground, background)

    const size = parseFloat(style.fontSize)
    const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700)
    const required = large ? 3 : 4.5

    if (ratio < required) {
      problems.push({
        kind: 'low-contrast',
        detail: text.slice(0, 40),
        value: Number(ratio.toFixed(2)),
        required,
      })
    }
  }

  return problems
})()`

const PAGES = [
  '/',
  '/browse',
  '/my-list',
  '/history',
  '/admin',
  '/admin/drafts',
  '/admin/library',
  '/admin/jobs',
  '/admin/ingest',
  '/admin/lists',
  '/admin/people',
  '/admin/users',
  '/admin/upload',
]

test.describe('legibility', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page)
  })

  for (const path of PAGES) {
    test(`${path} has no unreadable text or invisible controls`, async ({ page }) => {
      await visit(page, path)
      const problems = await page.evaluate(AUDIT)

      expect(
        problems,
        `${path}:\n${problems.map(p => `  ${p.kind} (${p.value}) — ${p.detail}`).join('\n')}`,
      ).toEqual([])
    })
  }

  test('the player page too', async ({ page }) => {
    await visit(page, '/')
    await page.locator('main a[href^="/c/"]').first().click()
    await page.waitForURL(/\/c\/.+\/.+/)

    // Post a comment so its controls are on the page to be judged. Unique per
    // run, or repeated runs pile up identical text and the locator turns
    // ambiguous.
    const marker = `Legibility check ${Date.now()}`
    await page.getByPlaceholder(/Say something/).fill(marker)
    await page.getByRole('button', { name: 'Post' }).click()
    await expect(page.getByText(marker)).toBeVisible()

    const problems = await page.evaluate(AUDIT)
    expect(
      problems,
      `player:\n${problems.map(p => `  ${p.kind} (${p.value}) — ${p.detail}`).join('\n')}`,
    ).toEqual([])
  })
})
