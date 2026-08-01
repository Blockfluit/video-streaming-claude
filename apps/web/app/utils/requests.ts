import { REQUEST_STATUSES, type RequestStatus } from '@video/shared'

/**
 * How a request is shown, shared by the viewer page and the admin screen.
 *
 * Both render the same statuses, and two divergent copies of "what colour is
 * REJECTED" is how one screen ends up calling it something the other does not.
 * Auto-imported from `app/utils`, the way `apiMessage` is.
 */

/** What `GET /requests` returns. The admin-only fields are null for everyone else. */
export interface RequestView {
  id: string
  title: string
  year: number | null
  comment: string | null
  status: RequestStatus
  adminNote: string | null
  createdAt: string
  /** Whether this is the caller's own request. */
  mine: boolean
  requestedBy: { id: string, username: string, displayName: string } | null
  statusChangedBy: { id: string, displayName: string } | null
  statusChangedAt: string | null
  updatedAt: string | null
  libraryMatch: {
    kind: 'video' | 'collection'
    id: string
    slug: string
    title: string
    state: string
    collection?: { slug: string, title: string } | null
    season?: { slug: string } | null
  } | null
}

/** `NOT_AVAILABLE` is not a word. */
const LABELS: Record<RequestStatus, string> = {
  NEW: 'New',
  SEEN: 'Seen',
  PROCESSING: 'Processing',
  NOT_AVAILABLE: 'Not available',
  REJECTED: 'Rejected',
  AVAILABLE: 'Available',
}

/**
 * Badge colours. `AVAILABLE` is the only good news, `REJECTED` the only refusal;
 * the rest are stages, not verdicts, and are coloured as such.
 */
const COLOURS: Record<RequestStatus, 'neutral' | 'info' | 'warning' | 'success' | 'error'> = {
  NEW: 'info',
  SEEN: 'neutral',
  PROCESSING: 'warning',
  NOT_AVAILABLE: 'neutral',
  REJECTED: 'error',
  AVAILABLE: 'success',
}

export function requestStatusLabel(status: RequestStatus): string {
  return LABELS[status] ?? status
}

export function requestStatusColour(status: RequestStatus) {
  return COLOURS[status] ?? 'neutral'
}

/**
 * Options for a status `<select>`.
 *
 * Reka UI reserves the empty string for "cleared" and throws during render if it
 * is given one as a value — which takes the whole page down, not just the
 * control. Hence a sentinel for "no filter".
 */
export const ANY_STATUS = 'ANY'

export const requestStatusOptions = REQUEST_STATUSES.map(status => ({
  label: requestStatusLabel(status),
  value: status,
}))

export const requestStatusFilterOptions = [
  { label: 'Any status', value: ANY_STATUS },
  ...requestStatusOptions,
]
