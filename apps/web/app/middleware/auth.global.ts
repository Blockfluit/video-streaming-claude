/**
 * Sends signed-out visitors to `/login`.
 *
 * This is **navigation, not access control**. Every request the app makes is
 * authorised by the API, which re-reads the user each time; this only spares
 * someone a page full of failed requests when the answer is "sign in first".
 * Nothing here is a security boundary, and nothing should be added that assumes
 * it is.
 *
 * Global, so a new page is behind it the moment it exists — the same
 * fail-closed reasoning as `SessionGuard` on the API.
 */

/** The only routes reachable without a session. */
const PUBLIC_ROUTES = new Set(['/login', '/setup'])

export default defineNuxtRouteMiddleware(async (to) => {
  const user = useSessionUser()

  // Fetched once and shared: on the server it happens during SSR, and Nuxt
  // transfers the state, so hydration does not ask again.
  if (user.value === null) {
    user.value = await fetchSessionUser()
  }

  const isPublic = PUBLIC_ROUTES.has(to.path)

  if (user.value === null && !isPublic) {
    // `redirect` so the sign-in lands them where they were going, rather than
    // dumping them on the home page having forgotten what they clicked.
    return navigateTo({ path: '/login', query: { redirect: to.fullPath } })
  }

  // Already signed in and looking at the sign-in page: nothing to do here.
  if (user.value !== null && isPublic) {
    return navigateTo('/')
  }
})
