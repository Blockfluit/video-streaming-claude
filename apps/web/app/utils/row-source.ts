import { ROW_SOURCE_SPECS, type RowSourceSpec } from '@video/shared'

/**
 * The spec for a row's source, for a screen that must render whatever arrives.
 *
 * `ROW_SOURCE_SPECS[row.source]` is a lookup on a value the API chose, and the
 * admin screen reads `.label`, `.hint` and `.fields` off the result. A source
 * the bundle has never heard of therefore throws inside `v-for` — and a page
 * whose render throws draws nothing at all, so one unrecognised row blanks the
 * whole screen rather than looking odd. That is not hypothetical here: the same
 * symptom, from a different cause, is what `auto-imports.spec.ts` exists for.
 *
 * A skew in that direction is the ordinary one. The API applies its migrations
 * at boot and the browser is handed whatever bundle the web container has, so a
 * deploy that moves one image and not the other — or a viewer holding an old
 * page open across a release — is enough.
 *
 * The fallback names the source rather than inventing a friendly title: the row
 * is real, an admin needs to be able to tell which one it is, and a label of
 * "Unknown" on three rows at once is no help. `fields` is deliberately empty, so
 * the form offers no setting rather than a wrong one.
 */
export function rowSpec(source: string): RowSourceSpec {
  return ROW_SOURCE_SPECS[source as keyof typeof ROW_SOURCE_SPECS] ?? {
    label: source,
    hint: 'This row comes from a newer version of the server, so its settings cannot be shown here.',
    fields: [],
  }
}
