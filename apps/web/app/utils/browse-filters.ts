/**
 * The browse page's filters, as the URL holds them.
 *
 * The URL is the source of truth rather than a copy of it: a narrowed library
 * is something you share, bookmark and come back to with the back button, and
 * none of that works if the state lives only in a `ref`. So there are two
 * mappings — URL to filters, filters to URL — and the fiddly parts are all in
 * the first: Vue Router hands over a string for one repeated parameter and an
 * array for several, and every value in a URL was typed by someone who may have
 * typed anything.
 *
 * Pure, and specced on its own, because a page cannot easily be asked "what
 * would you request for this URL".
 */

import type { LocationQuery } from 'vue-router'

/**
 * "No filter", as a value a `USelect` can hold.
 *
 * Never `''`: Reka UI reserves the empty string for "cleared" and throws during
 * render if given one, which takes the whole page down rather than the control.
 */
export const ANY = 'ANY'

export const BROWSE_SORTS = ['title', 'year', 'added'] as const
export type BrowseSort = (typeof BROWSE_SORTS)[number]

export const BROWSE_KINDS = ['FILM', 'SHOW'] as const
export type BrowseKind = (typeof BROWSE_KINDS)[number] | typeof ANY

export const BROWSE_STATES = ['DRAFT', 'PUBLISHED', 'ARCHIVED', 'MISSING'] as const

/** How many cards a page holds. The API's own default, and its cap is 100. */
export const BROWSE_PAGE_SIZE = 50

export interface BrowseFilters {
  q: string
  /** Provider-authored, several at a time, and narrowing rather than widening. */
  genres: string[]
  /** Curator-authored, one at a time — what the chips on a collection page link to. */
  tag: string | null
  kind: BrowseKind
  /** A lifecycle filter only an admin can act on; the API refuses it for anyone else. */
  state: string
  sort: BrowseSort
  offset: number
}

export const DEFAULT_BROWSE_FILTERS: BrowseFilters = {
  q: '',
  genres: [],
  tag: null,
  kind: ANY,
  state: ANY,
  sort: 'title',
  offset: 0,
}

/** A parameter as the router hands it over: absent, one value, or several. */
type QueryValue = LocationQuery[string] | undefined

/** The first value, whichever shape the router used for it. */
function one(value: QueryValue): string {
  const first = Array.isArray(value) ? value[0] : value

  return typeof first === 'string' ? first : ''
}

function many(value: QueryValue): string[] {
  const values = Array.isArray(value) ? value : [value]

  return values.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
}

/**
 * A known value, or the fallback.
 *
 * Used for both halves of the round trip. A value out of the URL was typed by
 * whoever is holding the address bar, and a value out of a select is whatever
 * the component chose to emit — neither is worth breaking a page over, and both
 * mean the same thing when unrecognised: no filter.
 */
function oneOf<T extends string>(value: QueryValue, allowed: readonly T[], fallback: T): T {
  const found = one(value)

  return (allowed as readonly string[]).includes(found) ? (found as T) : fallback
}

/** A select's emitted value, narrowed. The controls are typed as plain strings. */
export function asKind(value: string): BrowseKind {
  return oneOf(value, BROWSE_KINDS, ANY)
}

export function asSort(value: string): BrowseSort {
  return oneOf(value, BROWSE_SORTS, 'title')
}

export function asState(value: string): string {
  return oneOf(value, BROWSE_STATES, ANY)
}

export function parseBrowseFilters(query: LocationQuery): BrowseFilters {
  const offset = Number.parseInt(one(query.offset), 10)

  return {
    q: one(query.q),
    genres: many(query.genre),
    tag: one(query.tag) || null,
    kind: oneOf(query.kind, BROWSE_KINDS, ANY),
    state: oneOf(query.state, BROWSE_STATES, ANY),
    sort: oneOf(query.sort, BROWSE_SORTS, 'title'),
    offset: Number.isFinite(offset) && offset > 0 ? offset : 0,
  }
}

/**
 * The URL for a set of filters, with everything left at its default omitted.
 *
 * `/browse` is what you get when you have narrowed nothing, rather than
 * `/browse?sort=title&kind=ANY&offset=0` — which says the same thing and reads
 * like a bug.
 */
export function browseFiltersToQuery(filters: BrowseFilters): LocationQuery {
  return {
    ...(filters.q ? { q: filters.q } : {}),
    ...(filters.genres.length ? { genre: filters.genres } : {}),
    ...(filters.tag ? { tag: filters.tag } : {}),
    ...(filters.kind !== ANY ? { kind: filters.kind } : {}),
    ...(filters.state !== ANY ? { state: filters.state } : {}),
    ...(filters.sort !== 'title' ? { sort: filters.sort } : {}),
    ...(filters.offset > 0 ? { offset: String(filters.offset) } : {}),
  }
}

/**
 * The API query string.
 *
 * Deliberately not the same as the URL's: the API has no value meaning "any",
 * so a sentinel is an omission rather than a parameter, and `sort` is always
 * sent because the endpoint's default is not this page's business to assume.
 */
export function browseSearchParams(filters: BrowseFilters): string {
  const params = new URLSearchParams({ limit: String(BROWSE_PAGE_SIZE) })

  if (filters.q) params.set('q', filters.q)
  // Repeated, which is how the endpoint reads a list.
  for (const genre of filters.genres) params.append('genre', genre)
  if (filters.tag) params.set('tag', filters.tag)
  if (filters.kind !== ANY) params.set('kind', filters.kind)
  if (filters.state !== ANY) params.set('state', filters.state)
  params.set('sort', filters.sort)
  if (filters.offset > 0) params.set('offset', String(filters.offset))

  return params.toString()
}

export const KIND_LABELS: Record<string, string> = { FILM: 'Films', SHOW: 'Shows' }

/** Sentence case, so a state reads as a word rather than as a database value. */
export function stateLabel(state: string): string {
  return state.charAt(0) + state.slice(1).toLowerCase()
}

export interface FilterChip {
  label: string
  /** The change that removes this one narrowing, leaving the others alone. */
  clear: Partial<BrowseFilters>
}

/**
 * What is currently narrowing the list, each with a way to undo just itself.
 *
 * The search box is deliberately absent: it already shows its own text, and a
 * chip repeating it says the same thing twice. Every genre gets its own chip
 * rather than one chip for all of them, because dropping one of three is the
 * common move.
 */
export function activeFilterChips(filters: BrowseFilters): FilterChip[] {
  const chips: FilterChip[] = filters.genres.map((genre) => ({
    label: genre,
    clear: { genres: filters.genres.filter((other) => other !== genre) },
  }))

  if (filters.tag) chips.push({ label: `Tagged “${filters.tag}”`, clear: { tag: null } })
  if (filters.kind !== ANY) {
    chips.push({ label: KIND_LABELS[filters.kind] ?? filters.kind, clear: { kind: ANY } })
  }
  if (filters.state !== ANY) {
    chips.push({ label: stateLabel(filters.state), clear: { state: ANY } })
  }

  return chips
}

/** Whether anything at all is narrowing the list — what "Clear all" is offered for. */
export function hasActiveFilters(filters: BrowseFilters): boolean {
  return Boolean(filters.q) || activeFilterChips(filters).length > 0
}
