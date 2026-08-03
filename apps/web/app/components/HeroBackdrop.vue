<script setup lang="ts">
/**
 * Artwork across the top of a page, with the content laid over it.
 *
 * Extracted from the home page once the title pages needed the same thing.
 * Three screens drawing their own scrims is how one of them ends up fading to
 * the wrong colour — which already happened here: the first version hardcoded
 * `#08080a`, and when the page background moved to `#0a0a0c` the artwork ended
 * on a visible horizontal seam.
 *
 * So the gradients are written as real `linear-gradient`s interpolating to
 * `var(--ui-bg)` itself rather than as utilities, and they live in one file.
 */
const props = defineProps<{
  /** Absent is normal — nothing probed yet, or no poster chosen. */
  image?: string | null
  /**
   * `wide` is the home hero. `tall` gives a collection page room for its
   * metadata while leaving its episode list near the fold — a list nobody can
   * see without scrolling is the thing that page is for, hidden.
   *
   * `full` is for a video's page, which has no such list: a standalone film has
   * no cast, no tags and no siblings, so a `tall` hero left its text stranded
   * mid-screen above a few hundred pixels of empty background. Filling the
   * viewport makes that a composition rather than a gap.
   */
  size?: 'wide' | 'tall' | 'full'
}>()

const broken = ref(false)
const showImage = computed(() => Boolean(props.image) && !broken.value)

/**
 * `svh` rather than `vh` for the full-height hero: `vh` ignores a mobile
 * browser's collapsing address bar, so the hero is taller than the screen on
 * first paint and the page starts out scrolled by the height of the toolbar.
 */
const band = computed(() => ({
  wide: 'h-[58vh] min-h-100',
  tall: 'min-h-125 pt-28 pb-10 sm:min-h-140',
  full: 'min-h-[88svh] pt-28 pb-10',
}[props.size ?? 'wide']))

/** Home centres its hero; a title page sits its text on the floor of the frame. */
const anchor = computed(() => (props.size === 'wide' || !props.size ? 'items-center' : 'items-end'))

watch(
  () => props.image,
  () => {
    // A client-side navigation swaps the src on the same element. Without this
    // reset, one broken poster hides every subsequent one.
    broken.value = false
  },
)
</script>

<template>
  <!-- Full-bleed, and it runs under the transparent header on purpose. -->
  <!--
    `flex flex-col` so the content wrapper below can actually grow. A percentage
    height inside a section sized by `min-height` has no definite parent to
    resolve against, so `h-full` collapses to the content and `items-end` does
    nothing — which left a title page's hero text stranded at the top of a tall
    band of artwork.
  -->
  <section class="relative flex w-full flex-col overflow-hidden" :class="band">
    <img
      v-if="showImage"
      :src="image!"
      alt=""
      class="absolute inset-0 size-full object-cover"
      @error="broken = true"
    >

    <!--
      Two scrims. The bottom one is half the hero rather than a fixed height:
      on a short viewport a fixed value leaves the seam above the fold, which
      is exactly where it is most obvious.
    -->
    <div
      class="absolute inset-0"
      style="background: linear-gradient(to right, var(--ui-bg) 0%, color-mix(in srgb, var(--ui-bg) 78%, transparent) 42%, transparent 72%)"
    />
    <div
      class="absolute inset-x-0 bottom-0 h-1/2"
      style="background: linear-gradient(to top, var(--ui-bg) 0%, color-mix(in srgb, var(--ui-bg) 55%, transparent) 55%, transparent 100%)"
    />

    <div class="relative flex flex-1" :class="anchor">
      <div class="page-shell w-full">
        <slot />
      </div>
    </div>
  </section>
</template>
