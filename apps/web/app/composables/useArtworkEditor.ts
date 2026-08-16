import type { MaybeRefOrGetter } from 'vue'
import { toValue } from 'vue'

import type { ArtworkShape } from './useArtworkBust'

/**
 * The admin side of a poster or banner: replace it, and make the page show it.
 *
 * `useArtworkBust` already owned the cache-busting half, because a picture's
 * storage key does not change when it is replaced and an `<img>` the browser
 * never re-requests goes on showing the old one. The *request* half was left
 * behind, so the video editor and the collection editor each defined their own
 * `uploadArtwork` and `metadataApplied` with the same body — pull the file off
 * the input, build a `FormData`, post it, bump the buster, refresh — differing
 * only in the resource segment and the wording of a toast.
 *
 * Keeping the two halves together is the point: the failure mode of the pair is
 * an upload that works and a screen that goes on showing the previous picture,
 * which reads as the upload having silently failed.
 *
 * Resetting is deliberately **not** here. The two pages mean different things by
 * it — a video goes back to automatic and refreshes its jobs panel, a collection
 * goes back to inheriting its first episode's artwork — and they are one caller
 * each, not a duplicated pair.
 */
export function useArtworkEditor(
  entity: 'videos' | 'collections',
  id: MaybeRefOrGetter<string | undefined>,
  refresh: () => Promise<unknown>,
) {
  const api = useApi()
  const toast = useToast()
  const bust = useArtworkBust(entity, id)

  return {
    url: bust.url,
    replaced: bust.replaced,

    /** Sends the picked file, then makes the page ask for the new picture. */
    async upload(
      event: Event,
      shape: ArtworkShape,
      messages: { success?: string } = {},
    ): Promise<void> {
      const file = (event.target as HTMLInputElement).files?.[0]
      if (!file) return

      const body = new FormData()
      body.append('file', file)

      try {
        await api(`/${entity}/${toValue(id)}/${shape}`, { method: 'POST', body })
        bust.replaced(shape)
        await refresh()
        if (messages.success) toast.add({ title: messages.success, color: 'success' })
      }
      catch (error) {
        toast.add({ title: apiMessage(error, 'Could not upload that image'), color: 'error' })
      }
    },

    /**
     * After a metadata import, which can replace either shape, both, or neither.
     *
     * The dialog says which, because the refreshed record reads the same either
     * way. Bumping more than it names would reload a picture the import never
     * touched, and the panel would stop telling the truth about what it did.
     */
    async applied(replaced: ArtworkShape[]): Promise<void> {
      bust.replaced(...replaced)
      await refresh()
    },
  }
}
