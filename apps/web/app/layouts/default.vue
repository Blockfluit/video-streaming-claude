<script setup lang="ts">
/**
 * The signed-in shell. The two auth pages opt out with `layout: false`.
 *
 * The header is transparent at the top of the page and gains a background once
 * you scroll — over a full-bleed hero a solid bar would cut the artwork in
 * half before you had seen it.
 */
const { user, isAdmin } = useSession()
const api = useApi()
const route = useRoute()

const links = computed(() => [
  { label: 'Home', to: '/' },
  { label: 'Browse', to: '/browse' },
  { label: 'My List', to: '/my-list' },
  { label: 'Requests', to: '/requests' },
  ...(isAdmin.value ? [{ label: 'Manage', to: '/admin' }] : []),
])

const scrolled = ref(false)
const onScroll = () => {
  scrolled.value = window.scrollY > 8
}
onMounted(() => {
  onScroll()
  window.addEventListener('scroll', onScroll, { passive: true })
})
onBeforeUnmount(() => window.removeEventListener('scroll', onScroll))

async function signOut() {
  await api('/auth/logout', { method: 'POST' })
  user.value = null
  await navigateTo('/login')
}

/**
 * The account menu's items, hoisted out of the template.
 *
 * `scrolled` is written by a scroll listener, so this component re-renders
 * several times a second while the page moves. An array literal in the
 * template is a new identity on every one of those ticks, handed to a menu
 * that may be open at the time; a computed is one identity until the role
 * changes.
 *
 * History lives here rather than in the header: it is one person's viewing,
 * not a way into the library, and the two are the same kind of thing as
 * `Manage library` — somewhere your account takes you. The nested arrays are
 * groups, so `Sign out` sits behind a separator instead of flush against a
 * destination you were aiming for.
 */
const accountItems = computed(() => [
  [
    { label: 'History', icon: 'i-lucide-history', to: '/history' },
    ...(isAdmin.value ? [{ label: 'Manage library', icon: 'i-lucide-sliders-horizontal', to: '/admin' }] : []),
  ],
  [{ label: 'Sign out', icon: 'i-lucide-log-out', onSelect: signOut }],
])

const isActive = (to: string) => (to === '/' ? route.path === '/' : route.path.startsWith(to))
</script>

<template>
  <div class="min-h-screen bg-(--ui-bg)">
    <header
      class="fixed inset-x-0 top-0 z-50 transition-colors duration-300"
      :class="scrolled ? 'bg-[#08080a]/95 backdrop-blur border-b border-(--ui-border)' : 'bg-gradient-to-b from-black/80 to-transparent'"
    >
      <div class="page-shell flex h-16 items-center gap-8">
        <NuxtLink to="/" class="shrink-0 text-xl font-bold tracking-tight text-(--ui-primary)">
          LIBRARY
        </NuxtLink>

        <nav class="flex grow items-center gap-6">
          <NuxtLink
            v-for="link in links"
            :key="link.to"
            :to="link.to"
            class="text-sm transition-colors"
            :class="isActive(link.to) ? 'font-semibold text-white' : 'text-(--ui-text-muted) hover:text-(--ui-text-highlighted)'"
          >
            {{ link.label }}
          </NuxtLink>
        </nav>

        <!--
          The account menu.

          `align: 'end'` rather than the default `center`: the panel is wider
          than the avatar it hangs from and that avatar is the last thing in the
          bar, so a centred panel overhangs it on both sides and is then nudged
          back by `collisionPadding` — it lines up with nothing. Ending both on
          the same edge puts the panel's right side on the shell's right padding,
          which is where the header's content stops.

          `modal: false` because a menu is not a modal. The modal path locks the
          body (`overflow: hidden` plus a `padding-right` meant to stand in for
          the scrollbar it just hid), and `main.css` already reserves that gutter
          permanently — so the padding compensates for a width that never
          changed and shifts the page instead. Escape and click-outside still
          close it; only the body lock and the focus trap go.

          Panel width goes through `ui.content`, not `class`: with a default slot
          present `class` styles the *trigger*.
        -->
        <UDropdownMenu
          v-if="user"
          :items="accountItems"
          :modal="false"
          :content="{ align: 'end', sideOffset: 10 }"
          :ui="{ content: 'w-60' }"
        >
          <template #default="{ open }">
            <!--
              Reka gives the trigger `aria-haspopup`/`aria-expanded` but no name,
              so without this it announces as the two initials inside it.
            -->
            <button
              type="button"
              aria-label="Your account"
              class="flex items-center gap-2 rounded text-sm text-(--ui-text) transition-colors hover:text-(--ui-text-highlighted)"
            >
              <span
                class="grid size-8 place-items-center rounded bg-red-700 text-xs font-bold text-white"
                :class="open && 'ring-2 ring-(--ui-border-accented)'"
              >
                {{ user.displayName.slice(0, 2).toUpperCase() }}
              </span>
              <UIcon
                name="i-lucide-chevron-down"
                class="size-4 transition-transform duration-150 motion-reduce:transition-none"
                :class="open && 'rotate-180'"
              />
            </button>
          </template>

          <!--
            Whose account this is. Without it the panel is two unlabelled
            buttons floating near a corner, and `Manage library` repeats a nav
            link a few inches to its left.
          -->
          <template #content-top>
            <div class="border-b border-(--ui-border) px-3 py-2.5">
              <p class="truncate text-sm font-semibold text-(--ui-text-highlighted)">
                {{ user.displayName }}
              </p>
              <p class="mt-0.5 text-[11px] uppercase tracking-wider text-(--ui-text-muted)">
                {{ isAdmin ? 'Admin' : 'Member' }}
              </p>
            </div>
          </template>
        </UDropdownMenu>
      </div>
    </header>

    <main>
      <slot />
    </main>
  </div>
</template>
