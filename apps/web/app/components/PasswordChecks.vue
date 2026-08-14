<script setup lang="ts">
/**
 * The live checklist under the password pair on the signup form.
 *
 * It exists because the account this form creates cannot be recovered: the
 * library sends no mail and has no reset flow, so the first time anyone learns
 * their password was mistyped is when they cannot get back in. Telling them
 * why the button will not work, while they are still looking at the fields,
 * is the whole job.
 *
 * The rules come from `passwordChecks`, which is pure and tested; this renders
 * them and nothing else.
 */
const props = defineProps<{ password: string; confirm: string }>()

const checks = computed(() => passwordChecks(props.password, props.confirm))

/**
 * Icon and wording carry the state, never colour on its own.
 *
 * Roughly one man in twelve cannot separate red from green, and this is a form
 * you cannot recover from getting wrong — so the tick, the cross and the dash
 * have to be legible with the colour removed entirely.
 *
 * What varies instead is **brightness**, and it runs the useful way round: the
 * outstanding rule is the brightest line and the satisfied one recedes. A
 * checklist that lights up what is already done draws the eye to the part that
 * needs no attention.
 *
 * All three are palette tiers measured against `--ui-bg` — `--ui-text` at
 * 16.1:1, `--ui-text-muted` at 7.1:1, `--ui-text-dimmed` at 4.9:1 — so the
 * quietest is still clear of AA. `--ui-primary` is deliberately absent: accent
 * marks things and never sets type, and this app has already learned that
 * saturated accent text at 12px scores well and reads badly.
 */
const APPEARANCE = {
  pending: { icon: 'i-lucide-minus', class: 'text-(--ui-text-dimmed)' },
  met: { icon: 'i-lucide-check', class: 'text-(--ui-text-muted)' },
  unmet: { icon: 'i-lucide-x', class: 'text-(--ui-text)' },
} as const
</script>

<template>
  <!--
    Announced politely, so someone using a screen reader hears the match state
    flip as they type rather than discovering it on a rejected submit. `polite`
    rather than `assertive`: this should wait for a pause in typing, not
    interrupt every keystroke.
  -->
  <ul class="mt-2 space-y-1" aria-live="polite">
    <li
      v-for="check in checks"
      :key="check.id"
      class="flex items-center gap-1.5 text-xs"
      :class="APPEARANCE[check.state].class"
    >
      <UIcon :name="APPEARANCE[check.state].icon" class="size-3.5 shrink-0" />
      <!--
        The state is spoken as well as drawn. The icon is decorative to assistive
        technology (it is a mask-image with no text of its own), so without this
        the list would read as two requirements with no indication of either.
      -->
      <span class="sr-only">{{
        check.state === 'met' ? 'Done:' : check.state === 'unmet' ? 'Not yet:' : 'Required:'
      }}</span>
      <span>{{ check.label }}</span>
    </li>
  </ul>
</template>
