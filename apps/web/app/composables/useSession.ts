/**
 * Who is signed in, as far as the browser is concerned.
 *
 * `useState` rather than Pinia — at this size a shared ref is the whole
 * requirement, and it is SSR-safe by construction.
 *
 * This is a **convenience, never an authority**. The API re-reads the user on
 * every request and is the only thing that decides what may be done; anything
 * here is a hint for rendering. A deactivated account whose cookie is still
 * warm will look signed in until its next request, and that is fine — the
 * request is what fails.
 */

export interface SessionUser {
  id: string
  username: string
  displayName: string
  role: 'ADMIN' | 'USER'
  isActive: boolean
}

export function useSessionUser() {
  return useState<SessionUser | null>('session-user', () => null)
}

/**
 * Loads the current user once per page load.
 *
 * A 401 is the ordinary answer for a signed-out visitor, not a failure, so it
 * resolves to `null` rather than throwing — the global middleware turns that
 * into a redirect.
 */
export async function fetchSessionUser(): Promise<SessionUser | null> {
  const api = useApi()

  try {
    return await api<SessionUser>('/auth/me')
  } catch {
    return null
  }
}

export function useSession() {
  const user = useSessionUser()

  return {
    user,
    isSignedIn: computed(() => user.value !== null),
    isAdmin: computed(() => user.value?.role === 'ADMIN'),
  }
}
