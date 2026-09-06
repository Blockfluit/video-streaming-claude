// apps/web/app/utils/feedback-capture.ts
/**
 * Snapshots the current page into a PNG data URL for the feedback dialog.
 *
 * Dynamically imported so html2canvas — which touches `document` at module
 * scope — is never pulled into the SSR bundle; this only ever runs from a
 * click. Cannot capture cross-origin iframes (the hero trailer) or reliably
 * capture <video>/live <canvas> content — those render blank or frozen. Not
 * worked around; the text message still describes what's wrong, and a failed
 * capture degrades to a text-only submission rather than blocking the dialog.
 */
export async function captureScreenshot(): Promise<string | null> {
  try {
    const { default: html2canvas } = await import('html2canvas')
    const canvas = await html2canvas(document.body, {
      ignoreElements: el => el.closest('[data-feedback-ui]') !== null,
    })
    return canvas.toDataURL('image/png')
  }
  catch {
    return null
  }
}
