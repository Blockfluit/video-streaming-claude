import { type MaybeRefOrGetter, reactive, toValue } from 'vue'

export type ArtworkShape = 'poster' | 'banner'

/**
 * The artwork URLs an admin screen edits through, with a cache-buster per shape.
 *
 * A picture's storage key does not change when it is replaced, so the ETag alone cannot
 * help an `<img>` the browser never re-requests: the `src` has to change, or nothing is
 * asked for at all. Per shape rather than one shared counter, or replacing the banner
 * would silently reload the poster too and hide whether the thing you just did worked.
 *
 * Shared rather than written out once per screen because forgetting to say a picture was
 * replaced is invisible — the screen goes on showing the old one and reports success.
 * That is exactly how the TMDB import shipped: it wrote both shapes and told nobody.
 *
 * The version is a counter, not a clock. Two replacements inside one millisecond produce
 * the same `Date.now()`, and therefore the same URL, which is the one case a cache-buster
 * exists to cover.
 *
 * The id is a getter as much as a value: a collection page only has one once its fetch
 * has resolved.
 */
export function useArtworkBust(
  entity: 'videos' | 'collections',
  id: MaybeRefOrGetter<string | undefined>,
) {
  const version = reactive<Record<ArtworkShape, number>>({ poster: 0, banner: 0 })

  return {
    /** Where a shape is served from, as it stands after the replacements so far. */
    url(shape: ArtworkShape): string {
      return `/api/${entity}/${toValue(id)}/${shape}?v=${version[shape]}`
    },

    /**
     * Say which shapes have just been replaced, so the next render re-requests them.
     * Naming none is meaningful — it is what an import that took no artwork passes.
     */
    replaced(...shapes: ArtworkShape[]): void {
      for (const shape of shapes) version[shape] += 1
    },
  }
}
