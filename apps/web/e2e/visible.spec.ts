import { expect, test, visit } from './fixtures'

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

/** WCAG AA: 4.5:1 for body text, 3:1 for large and for control boundaries. */
const AUDIT = `(() => {
  // Kept in step with --ui-bg in assets/css/main.css. Anything painted with
  // alpha composites down onto this, so a stale value quietly shifts every
  // ratio on the page.
  const PAGE_BG = '#0a0a0c'

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
  //
  // 'from' decides whether the element's OWN background counts as behind it.
  // Text and borders both paint on top of it, so it does. A mask-image icon is
  // the exception: its colour IS its background-color, and including it
  // compares the colour against itself and reports a flat 1:1 for every icon
  // on the page.
  const backdrop = (el, from) => {
    const layers = []
    for (let node = from || el; node; node = node.parentElement) {
      const style = getComputedStyle(node)
      if (style.backgroundImage !== 'none') return null // a gradient or photo
      layers.unshift(style.backgroundColor)
    }
    return [PAGE_BG, ...layers]
  }

  const problems = []
  const OPAQUE_ENOUGH = 0.35

  // The whole document, not 'main *, header *, aside *'. Reka UI teleports
  // dropdown, select and modal content to <body>, so scoping to the landmarks
  // left every popover in the app unaudited.
  for (const el of document.querySelectorAll('*')) {
    const text = (el.textContent || '').trim()
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') continue
    const box = el.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) continue

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

    const layers = backdrop(el)

    /*
     * A placeholder is the one piece of text whose whole job is to be read
     * before anything else on the field, and it is styled by a pseudo-element
     * the loop below cannot reach. Ours sat at 4.15:1 — under AA, and invisible
     * to an audit that only walks real elements.
     */
    if (layers && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.placeholder) {
      const colour = getComputedStyle(el, '::placeholder').color
      const ratio = contrast(paint([...layers, colour]), paint(layers))
      if (ratio < 4.5) {
        problems.push({
          kind: 'low-contrast-placeholder',
          detail: el.placeholder.slice(0, 40),
          value: Number(ratio.toFixed(2)),
          required: 4.5,
        })
      }
    }

    /*
     * Border contrast (WCAG 1.4.11, 3:1). This is the check that would have
     * caught the original palette: --ui-border was 1.29:1 against the page, so
     * cards and inputs had an edge you could find with a colour picker and not
     * with your eyes, and every text ratio on the page still passed.
     */
    if (layers && el.matches('button, a[href], input, select, textarea, [role="option"], [role="menuitem"]')) {
      for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
        const width = parseFloat(style['border' + side + 'Width'])
        if (!width || style['border' + side + 'Style'] === 'none') continue
        const ratio = contrast(paint([...layers, style['border' + side + 'Color']]), paint(layers))
        if (ratio < 3) {
          problems.push({
            kind: 'low-contrast-border',
            detail: (el.getAttribute('aria-label') || text || el.tagName).slice(0, 40),
            value: Number(ratio.toFixed(2)),
            required: 3,
          })
        }
        break // one side is enough; four reports of one border is noise
      }
    }

    // Leaf text only: a container's textContent is its children's.
    if (!text || el.children.length > 0 || text.length > 80) continue
    if (opacity < 0.99) continue
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
  '/requests',
  '/admin',
  '/admin/drafts',
  '/admin/library',
  '/admin/jobs',
  '/admin/ingest',
  '/admin/lists',
  '/admin/people',
  '/admin/users',
  '/admin/upload',
  '/admin/comments',
  '/admin/requests',
]

test.describe('legibility', () => {

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
