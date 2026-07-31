import type { NitroFetchOptions } from 'nitropack'

/**
 * The only way this app talks to the API.
 *
 * It exists for one reason. During SSR, `useFetch` and `$fetch` run inside
 * Nitro rather than the browser, and Nitro has no cookie jar — so a call that
 * works perfectly on the client comes back 401 the moment the same page is
 * rendered on the server. The fix is to forward the incoming request's cookie
 * header, and the only reliable way to apply it is to have exactly one place
 * that can forget.
 *
 * `useRequestHeaders` returns `{}` in the browser, so the same code path is
 * correct on both sides.
 */

/** Prefixed so every call is same-origin and goes through the Nuxt proxy. */
const API_PREFIX = '/api'

function withApiPrefix(path: string): string {
  return path.startsWith('/') ? `${API_PREFIX}${path}` : `${API_PREFIX}/${path}`
}

/**
 * `$fetch` against the API, for event handlers — logging in, posting a comment,
 * anything triggered by a person rather than by a page rendering.
 */
export function useApi() {
  // Read during setup, not inside the returned closure: composables that touch
  // the request context have to be called synchronously from setup, and an
  // async handler running later is well outside it.
  const headers = useRequestHeaders(['cookie'])

  return <T>(path: string, options: NitroFetchOptions<string> = {}) =>
    $fetch<T>(withApiPrefix(path), {
      ...options,
      headers: { ...headers, ...options.headers },
    })
}

/**
 * `useFetch` against the API, for data a page needs in order to render.
 *
 * Deduplicated and SSR-transferred by Nuxt, so the payload fetched on the
 * server is not fetched again on hydration.
 */
export function useApiFetch<T>(
  path: string | (() => string),
  options: Parameters<typeof useFetch<T>>[1] = {},
) {
  const headers = useRequestHeaders(['cookie'])
  const url = () => withApiPrefix(typeof path === 'function' ? path() : path)

  return useFetch<T>(url, {
    ...options,
    headers: { ...headers, ...(options.headers as Record<string, string>) },
  })
}
