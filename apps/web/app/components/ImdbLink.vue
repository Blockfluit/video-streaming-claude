<script setup lang="ts">
/**
 * A link out to IMDb, for a title or a person.
 *
 * The library stores an id and links; it does not copy IMDb's page. That is the
 * whole reason a `Person` row holds a name and two ids and nothing else.
 *
 * Renders **nothing** when there is no id, which is the ordinary state of
 * anything nobody has matched yet — an icon that goes nowhere is worse than an
 * absent one.
 */
const props = withDefaults(
  defineProps<{
    /** `tt…` for a title, `nm…` for a person. */
    imdbId?: string | null
    kind?: 'title' | 'person'
    /** What the link is *for*, so the accessible name names the thing. */
    label?: string
  }>(),
  { imdbId: null, kind: 'title', label: '' },
)

const href = computed(() =>
  props.kind === 'person' ? imdbPersonUrl(props.imdbId) : imdbTitleUrl(props.imdbId),
)

/**
 * `@nuxt/ui` controls ship their own `aria-label`, which shadows any visible
 * text — `USelectMenu`'s announced name was "Show popup". This is a bare anchor
 * for that reason, and the name says what it opens rather than what it is.
 */
const ariaLabel = computed(() =>
  props.label ? `${props.label} on IMDb` : 'View on IMDb',
)
</script>

<template>
  <a
    v-if="href"
    :href="href"
    :aria-label="ariaLabel"
    :title="ariaLabel"
    target="_blank"
    rel="noopener noreferrer"
    class="inline-flex shrink-0 items-center rounded-sm text-(--ui-text-muted) transition-colors hover:text-[#f5c518] focus-visible:text-[#f5c518] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--ui-border-accented)"
  >
    <!--
      IMDb's own yellow only on hover and focus. Colour marks things here and
      never sets type, and a brand glyph sitting permanently lit next to a title
      competes with the title; muted-until-touched keeps the hierarchy and still
      clears AA at rest.
    -->
    <UIcon name="i-simple-icons-imdb" class="size-5" />
  </a>
</template>
