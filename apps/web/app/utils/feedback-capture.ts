// apps/web/app/utils/feedback-capture.ts
/**
 * Snapshots the current page into a PNG data URL for the feedback dialog.
 *
 * Dynamically imported so html2canvas-pro — which touches `document` at
 * module scope — is never pulled into the SSR bundle; this only ever runs
 * from a click. Cannot capture cross-origin iframes (the hero trailer) or
 * reliably capture <video>/live <canvas> content — those render blank or
 * frozen. Not worked around; the text message still describes what's wrong,
 * and a failed capture degrades to a text-only submission rather than
 * blocking the dialog.
 *
 * `-pro`, not the original `html2canvas`: the original cannot parse the
 * `oklab`/`oklch` colors this app's Tailwind4/`@nuxt/ui` theme resolves
 * computed colors to, so it threw on nearly every real page (the header's
 * gradient, card overlays, the hero scrim) and silently degraded to the
 * text-only fallback below every time. This fork adds exactly that support.
 *
 * Capped to the viewport, not the whole scrolled document. `html2canvas`
 * defaults to `document.body`'s full scrollable size *and* to
 * `devicePixelRatio` (2 on most modern laptops) — a long, scrolled page at
 * that combination routinely produced tens of megapixels, comfortably over
 * `MAX_FEEDBACK_SCREENSHOT_BYTES`. `scale: 1` removes the pixel-ratio
 * multiplier; `x`/`y` at the current scroll position plus `width`/`height` at
 * the viewport size crop to what the person was actually looking at when
 * they clicked the button, rather than the entire page above and below it.
 */
export async function captureScreenshot(): Promise<string | null> {
  try {
    const { default: html2canvas } = await import('html2canvas-pro')
    const canvas = await html2canvas(document.body, {
      ignoreElements: el => el.closest('[data-feedback-ui]') !== null,
      scale: 1,
      x: window.scrollX,
      y: window.scrollY,
      width: window.innerWidth,
      height: window.innerHeight,
      windowWidth: window.innerWidth,
      windowHeight: window.innerHeight,
    })
    return canvas.toDataURL('image/png')
  }
  catch {
    return null
  }
}

/**
 * The decoded byte length of a `data:...;base64,...` URL (or a bare base64
 * string), without actually decoding it.
 *
 * Base64 inflates by ~4/3 — checking the *encoded* string's length against a
 * byte limit undercounts how large the decoded image really is. Each `=`
 * padding character represents a byte that was not there to begin with.
 */
export function decodedByteLength(dataUrl: string): number {
  const base64 = dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}
