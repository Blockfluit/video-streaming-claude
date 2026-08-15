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

/**
 * Enough of a person to name them and link to them.
 *
 * The slug rides along because the headline is a row of links, not a sentence:
 * "Directed by Lana Wachowski" is the shortest path from a film to what else
 * she made, and a name that reads like a link and is not one is worse than
 * plain text.
 */
export interface HeadlinePerson {
  name: string
  slug: string
}

export interface HeadlineCredit {
  role: string
  person: HeadlinePerson
}

export interface HeadlineGroup {
  label: string
  people: HeadlinePerson[]
  /** How many were left off, so the line can say so rather than just stopping. */
  more: number
}

/** Sentence case from the enum, so a new role needs no change here. */
export function roleLabel(role: string): string {
  return role.charAt(0) + role.slice(1).toLowerCase()
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
    // writer of a film with both appeared twice in the same breath.
    //
    // Keyed on the **slug**, not the object: this used to be a `Set` of name
    // strings, and a `Set` of `{ name, slug }` records would dedupe nothing at
    // all — two credits for one person are two distinct objects — so that bug
    // would come back without a single test going red. A Map keeps first-seen
    // order, so the billing the server sent is untouched.
    const byPerson = new Map<string, HeadlinePerson>()
    for (const credit of credits) {
      if (credit.role !== role) continue
      if (!byPerson.has(credit.person.slug)) byPerson.set(credit.person.slug, credit.person)
    }
    const people = [...byPerson.values()]

    // A role nobody is credited in is omitted entirely. An empty "Written by"
    // reads as data that failed to load.
    if (people.length === 0) return []

    return [{
      label,
      people: people.slice(0, maxNames),
      more: Math.max(people.length - maxNames, 0),
    }]
  })
}

/**
 * One credit as `GET /people/:slug` serves it.
 *
 * `video.collections` is a **list of join rows**, not a collection. A film may
 * sit on several shelves and naming one of them would be an arbitrary choice,
 * which is why the singular `video.collection` this page used to read has been
 * gone for months — and reading it was not an error, just `undefined`, so the
 * card lost its second line and nothing said so.
 */
export interface FilmographyCredit {
  id: string
  role: string
  characterName: string | null
  collection: { id: string, slug: string, title: string, year: number | null } | null
  video: {
    id: string
    slug: string
    title: string
    collections?: readonly { collection: { id: string, slug: string, title: string } }[]
  } | null
}

/** A card in a filmography — enough to draw a tile and link it. */
export interface FilmographyCard {
  /** The **credit's** id: one title can hold two credits for one person. */
  creditId: string
  kind: 'collection' | 'video'
  /** The record's own id, which is what the artwork routes are keyed on. */
  id: string
  slug: string
  title: string
  subtitle: string | null
}

export interface FilmographyGroup {
  role: string
  label: string
  cards: FilmographyCard[]
}

/**
 * The second line under a card.
 *
 * A character name first: on an acting credit that is the whole point of the
 * card. Otherwise what the title belongs to — every shelf holding it, because
 * picking one would be arbitrary — and for a collection, its year.
 */
function subtitleFor(credit: FilmographyCredit): string | null {
  if (credit.characterName) return credit.characterName

  if (credit.collection) {
    return credit.collection.year === null ? null : String(credit.collection.year)
  }

  const titles = (credit.video?.collections ?? []).map(entry => entry.collection.title)

  return titles.length > 0 ? titles.join(' · ') : null
}

/**
 * A filmography, grouped by role.
 *
 * The server's order is kept exactly as sent. `role asc` in Postgres is the
 * enum's declaration order, which is the editorial order CLAUDE.md pins to
 * `Object.values(CreditRole)`; re-sorting here would replace it with
 * alphabetical, and a filmography that opens with "Cinematographer" is not one.
 *
 * A credit with neither parent is dropped rather than drawn as a card with
 * nowhere to go. The API's `OR` makes that impossible; the type does not.
 */
export function filmography(credits: readonly FilmographyCredit[]): FilmographyGroup[] {
  const byRole = new Map<string, FilmographyCard[]>()

  for (const credit of credits) {
    const parent = credit.collection
      ? { kind: 'collection' as const, record: credit.collection }
      : credit.video
        ? { kind: 'video' as const, record: credit.video }
        : null

    if (parent === null) continue

    const card: FilmographyCard = {
      creditId: credit.id,
      kind: parent.kind,
      id: parent.record.id,
      slug: parent.record.slug,
      title: parent.record.title,
      subtitle: subtitleFor(credit),
    }

    const list = byRole.get(credit.role)
    if (list) list.push(card)
    else byRole.set(credit.role, [card])
  }

  return [...byRole].map(([role, cards]) => ({ role, label: roleLabel(role), cards }))
}
