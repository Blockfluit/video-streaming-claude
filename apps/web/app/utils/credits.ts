/**
 * Which crew are worth a line before you ask for the rest.
 *
 * Pure, and tested, because "which crew matter" is a rule and a rule with an
 * off-by-one in it reads as missing data rather than as a bug. An import stores
 * every crew member — 264 of them on a television series — so what a page shows
 * before you press *Show all* is a real editorial decision, not a truncation.
 *
 * Three roles: the ones somebody scanning a film page is actually looking for.
 * Producers, cinematography and editing are behind the toggle with everyone
 * else; that is what the toggle is for.
 */

export interface HeadlineCredit {
  role: string
  person: { name: string }
}

export interface HeadlineGroup {
  label: string
  names: string[]
  /** How many were left off, so the line can say so rather than just stopping. */
  more: number
}

/**
 * Fixed order, and the labels read as a sentence rather than as column headings —
 * "Directed by X · Written by Y" is how a poster says it, and it costs a line
 * where seven role headings cost seven.
 */
const HEADLINE: readonly { role: string, label: string }[] = [
  { role: 'DIRECTOR', label: 'Directed by' },
  { role: 'WRITER', label: 'Written by' },
  { role: 'COMPOSER', label: 'Music by' },
]

/** Three names is a line; four is a paragraph. */
const MAX_NAMES = 3

export function headlineCrew(
  credits: readonly HeadlineCredit[],
  maxNames: number = MAX_NAMES,
): HeadlineGroup[] {
  return HEADLINE.flatMap(({ role, label }) => {
    // The API's order is deliberate and total (role, position, own-before-
    // inherited, name, id). Re-sorting here would throw that away and let the
    // line reshuffle between requests.
    //
    // Deduplicated, because one person routinely holds two credits that collapse
    // to the same role — Story *and* Screenplay both map to WRITER, so the
    // writer of a film with both appeared twice in the same breath. A Set keeps
    // first-seen order, so the billing is untouched.
    const names = [
      ...new Set(
        credits.filter(credit => credit.role === role).map(credit => credit.person.name),
      ),
    ]

    // A role nobody is credited in is omitted entirely. An empty "Written by"
    // reads as data that failed to load.
    if (names.length === 0) return []

    return [{ label, names: names.slice(0, maxNames), more: Math.max(names.length - maxNames, 0) }]
  })
}
