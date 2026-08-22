import { onBeforeMount, type Ref } from 'vue'

/**
 * Keeping what somebody typed before Vue was listening.
 *
 * A server-rendered input accepts keystrokes the moment it is painted, which is
 * well before the page hydrates — and `v-model`'s mounted hook then writes the
 * model's value into the element, silently throwing away everything typed in
 * between. `visible.spec.ts` and the sign-in setup already work around this from
 * the outside, by retrying; nothing put it right from the inside, and on the one
 * control where people *start* typing the instant the page appears it is not a
 * lost character but a search for the wrong words.
 *
 * Measured on `/browse` in dev, typing at 60 ms a key: start the moment the grid
 * paints and `chernobyl` searched for `nobyl`; 150 ms later, `ernobyl`; from
 * about 300 ms it is right. A production build hydrates faster, which narrows
 * the window without closing it — and narrower is worse to diagnose, not better,
 * because it turns a reproducible bug into an intermittent one. That is exactly
 * how it was reported: *sometimes* the search does nothing.
 *
 * **`onBeforeMount`, and that is the whole trick.** By `onMounted` the directive
 * has already overwritten the element, so reading it there returns the empty
 * string every time and looks like proof that nothing was lost. Before mount the
 * typed text is still sitting in the DOM, so adopting it into the model means the
 * directive writes back what the person actually typed.
 *
 * Found by `id` rather than a template ref for the same reason: a template ref is
 * populated at mount, one step too late.
 *
 * Runs on the client only — `onBeforeMount` does not fire during SSR, where
 * there is no DOM to read and nobody has typed anything.
 */
export function useTypedBeforeHydration(id: string, model: Ref<string>): void {
  onBeforeMount(() => {
    const element = document.getElementById(id)
    if (!(element instanceof HTMLInputElement)) return

    // Only ever adopts something. An empty element is the ordinary case — the
    // page just loaded — and must not clear a model seeded from the URL, which
    // is what happens when somebody opens a link that already carries a search.
    if (element.value && element.value !== model.value) model.value = element.value
  })
}
