/**
 * Three kinds of bug that every other test in this suite walks straight past.
 *
 * **Invisible controls.** Playwright happily clicks an element at `opacity: 0`,
 * and `toBeVisible()` does not check opacity either — so a button whose reveal
 * depends on a `group-hover` that no ancestor provides passes every functional
 * test while being, to a person, simply not there. That shipped here once.
 *
 * **Unreadable text.** A dark theme makes it easy to land on grey-on-black that
 * technically renders. Contrast is arithmetic, so it can just be measured.
 *
 * **Horizontal overflow.** A layout built at one width has no way of saying it
 * does not fit at another: the page simply scrolls sideways, and a column of it
 * sits off the right edge where nobody scrolls to look. Also arithmetic, and
 * the reason this file now runs at a phone viewport as well as a desktop one.
 */

/** WCAG AA: 4.5:1 for body text, 3:1 for large and for control boundaries. */
export const AUDIT = `(() => {
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

  /*
   * Horizontal overflow, which is the failure this audit could not see and the
   * one a phone hits first: a page that slides sideways under a thumb, with a
   * column of every screen parked off the right edge.
   *
   * The document is the assertion — scrollWidth against clientWidth is the
   * thing a person actually experiences, and clientWidth already excludes the
   * gutter 'scrollbar-gutter: stable' reserves. Individual boxes are only the
   * diagnosis, collected as the loop measures them anyway and reported only if
   * the document one fires.
   */
  const viewport = document.documentElement.clientWidth
  const wide = []

  // The whole document, not 'main *, header *, aside *'. Reka UI teleports
  // dropdown, select and modal content to <body>, so scoping to the landmarks
  // left every popover in the app unaudited.
  for (const el of document.querySelectorAll('*')) {
    const text = (el.textContent || '').trim()
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') continue
    const box = el.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) continue

    // Collected here, before every 'continue' below, or a faded control would
    // be exempt from the overflow check as well as from the contrast ones.
    if (box.right > viewport + 1 || box.left < -1) wide.push(el)

    // Effective opacity, which is what actually decides whether it is there.
    let opacity = 1
    for (let node = el; node; node = node.parentElement) {
      opacity *= Number(getComputedStyle(node).opacity)
    }

    /*
     * A control out of the tab order *and* out of the accessibility tree is
     * decoration for the mouse, and decoration may fade in on hover. Both are
     * required: either alone still leaves somebody landing on something they
     * cannot see. Anything a keyboard or screen reader reaches is judged as
     * before. (No backticks in this file's comments — the audit is one template
     * string evaluated in the page.)
     */
    const decorative = el.getAttribute('aria-hidden') === 'true' && el.tabIndex < 0

    const interactive = el.matches('button, a[href], input, select, textarea') && !decorative
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

  /*
   * A box wider than the viewport is only a bug when nothing is scrolling it.
   * The exemption is therefore by behaviour, not by a list of class names that
   * would drift away from the markup: walk up, and the first ancestor that
   * scrolls or clips on the x axis ends the walk. That covers the media rails,
   * the '.no-scrollbar' shelves and the admin tables at once, and a clipped
   * element is not overflowing anything either.
   */
  const contained = (el) => {
    for (let node = el.parentElement; node; node = node.parentElement) {
      const overflowX = getComputedStyle(node).overflowX
      if (overflowX !== 'visible') return true
    }
    return false
  }

  const excess = document.documentElement.scrollWidth - viewport
  if (excess > 1) {
    problems.push({
      kind: 'page-overflow',
      detail: 'the document scrolls sideways',
      value: excess,
      required: 0,
    })

    // Innermost only: one overflowing chip otherwise reports itself and every
    // wrapper above it, and the wrappers are not the thing to go and fix.
    const loose = wide.filter(el => !contained(el))
    const culprits = loose.filter(el => !loose.some(other => other !== el && el.contains(other)))

    for (const el of culprits.slice(0, 8)) {
      problems.push({
        kind: 'overflows-viewport',
        // The class list is what makes this actionable — an anonymous DIV is
        // not. getAttribute, never .className: on an SVG that is an
        // SVGAnimatedString and slicing it throws inside page.evaluate.
        detail: (el.getAttribute('aria-label') || el.tagName + ' ' + (el.getAttribute('class') || '')).slice(0, 70),
        value: Math.round(el.getBoundingClientRect().right),
        required: viewport,
      })
    }
  }

  return problems
})()`
