/**
 * Sanitising the `?redirect=` a sign-in carries.
 *
 * The middleware puts the page someone was heading for into the query so the
 * sign-in lands them there. That value comes back through the URL, which means
 * anybody can write it — and navigating to an attacker-chosen destination after
 * authenticating is an open redirect, the classic way a phishing link borrows a
 * real site's domain for its first hop.
 *
 * Only a same-site path is allowed through. Everything else falls back home,
 * silently: someone arriving on a tampered link should just end up somewhere
 * sensible.
 */

export const DEFAULT_REDIRECT = '/'

export function safeRedirect(target: unknown): string {
  if (typeof target !== 'string' || target.length === 0) return DEFAULT_REDIRECT

  // Must be an absolute path on this site. A bare `/` prefix is not enough:
  // `//evil.example` is protocol-relative and browsers treat it as off-site,
  // and `/\evil.example` is normalised the same way by some of them.
  if (!target.startsWith('/')) return DEFAULT_REDIRECT
  if (target.startsWith('//') || target.startsWith('/\\')) return DEFAULT_REDIRECT

  // A control character can smuggle a line break into a header or truncate the
  // checks above. Written as escapes: literal control bytes in source survive
  // neither a copy-paste nor a careless editor.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(target)) return DEFAULT_REDIRECT

  return target
}
