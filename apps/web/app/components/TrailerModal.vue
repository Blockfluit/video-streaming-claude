<script setup lang="ts">
import { youtubeEmbedUrl } from '@video/shared'

/**
 * The trailer, watched on purpose.
 *
 * The hero has always played one, and it has never been watchable: cropped to
 * the shape of the band, scrimmed twice so the text over it stays legible, and
 * silent because a browser will not start anything else. That is decoration, and
 * it is fine as decoration — but "play the trailer" is a thing people mean
 * literally, and there was nowhere for them to do it.
 *
 * So this is the deliberate one: 16:9 at the size of the dialog, sound on,
 * YouTube's own scrubber and fullscreen. It carries its own button, the way
 * `MetadataMatchModal` does, because the button and the dialog are one feature
 * and splitting them across a page and a component is how one of them ends up
 * rendered without the other.
 */
const props = defineProps<{
  /**
   * Absent is the common case — most of a library has no trailer — and this
   * renders nothing at all rather than a button that opens an empty box.
   */
  trailerId?: string | null
  /** The work's title, so the dialog names what is playing. */
  title?: string | null
}>()

/**
 * Exposed rather than private, because the page has to know: the ambient trailer
 * in the hero behind this dialog is a second copy of the same video, and the
 * home page's rotation would otherwise change the title underneath an open
 * player.
 */
const open = defineModel<boolean>('open', { default: false })

const heading = computed(() => (props.title ? `${props.title} — trailer` : 'Trailer'))

/**
 * `controls` and sound: the opposite of the hero's embed, and for the opposite
 * reason. Nothing is layered over this one, and a video player without a
 * scrubber is a worse video player.
 *
 * Unmuted is allowed here where it is refused in the hero — the browser's rule
 * is about video nobody asked for, and a click on `Trailer` is the asking.
 */
const embedUrl = computed(() =>
  props.trailerId
    ? youtubeEmbedUrl(props.trailerId, { muted: false, controls: true })
    : null,
)
</script>

<template>
  <UModal
    v-if="embedUrl"
    v-model:open="open"
    :title="heading"
    :ui="{ content: 'max-w-5xl' }"
  >
    <!--
      `neutral` and `subtle`, not the accent colour: accent marks things and
      never sets type, and this is not the call to action on any screen it
      appears on — Play is, and it is the solid one.

      An explicit `aria-label` because `@nuxt/ui` triggers ship labels of their
      own that shadow the visible text, and because "Trailer" alone does not say
      that pressing it starts something.
    -->
    <UButton
      color="neutral"
      variant="subtle"
      icon="i-lucide-clapperboard"
      :aria-label="title ? `Watch the trailer for ${title}` : 'Watch the trailer'"
    >
      Trailer
    </UButton>

    <template #body>
      <!--
        `aspect-video` rather than a height: the dialog is as wide as the screen
        allows and the player has to stay 16:9 inside it, or YouTube letterboxes
        itself and the black bars land inside the dialog's own padding.

        Black underneath, because the player's first frames are transparent and
        the page background showing through reads as a broken embed.
      -->
      <div class="aspect-video w-full overflow-hidden rounded-lg bg-black">
        <!--
          Rendered only while open, which does two jobs. Nothing is requested
          from YouTube until somebody asks for it — the same rule the hero
          follows — and closing the dialog *unmounts* the player, which is what
          actually stops the sound. A hidden iframe keeps playing, and a trailer
          you can hear but not find is worse than one that will not start.
        -->
        <iframe
          v-if="open"
          :src="embedUrl"
          class="size-full"
          :title="heading"
          frameborder="0"
          allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
          allowfullscreen
          referrerpolicy="strict-origin-when-cross-origin"
        />
      </div>
    </template>
  </UModal>
</template>
