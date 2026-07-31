/**
 * Keeps non-admins out of the management screens.
 *
 * Like `auth.global`, this is **navigation, not access control** — every admin
 * endpoint is guarded by `RolesGuard` on the API, which is the only thing that
 * decides anything. This exists so a viewer who follows a stale link gets sent
 * home instead of a page of 403s.
 */
export default defineNuxtRouteMiddleware(() => {
  const { isAdmin } = useSession()

  if (!isAdmin.value) return navigateTo('/')
})
