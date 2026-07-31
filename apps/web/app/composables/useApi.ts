import type { NitroFetchOptions } from 'nitropack'
import type { AsyncDataOptions } from 'nuxt/app'

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
 * Page data, fetched during SSR and transferred to the client rather than
 * fetched twice.
 *
 * Built on `useAsyncData` over the wrapper above rather than on `useFetch`.
 * `useFetch` is the more obvious choice and was the first attempt, but its
 * generics do not survive being wrapped — the payload type collapses and every
 * call site loses `.items`. `useAsyncData` takes the type parameter cleanly and
 * gives up nothing that matters here, since the URL is already a function.
 *
 * The explicit key is the price: `useFetch` derives one from the call site and
 * this cannot, so two pages sharing a key would share a cache entry.
 */
export function useApiData<T>(
  key: string,
  path: string | (() => string),
  options: Omit<AsyncDataOptions<T>, 'default'> = {},
) {
  const api = useApi()

  return useAsyncData<T>(
    key,
    () => api<T>(typeof path === 'function' ? path() : path),
    options,
  )
}
