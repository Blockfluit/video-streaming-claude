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
  { label: 'History', to: '/history' },
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

const isActive = (to: string) => (to === '/' ? route.path === '/' : route.path.startsWith(to))
</script>

<template>
  <div class="min-h-screen bg-(--ui-bg)">
    <header
      class="fixed inset-x-0 top-0 z-50 transition-colors duration-300"
      :class="scrolled ? 'bg-[#08080a]/95 backdrop-blur border-b border-white/12' : 'bg-gradient-to-b from-black/80 to-transparent'"
    >
      <div class="mx-auto flex h-16 max-w-[110rem] items-center gap-8 px-4 sm:px-8">
        <NuxtLink to="/" class="shrink-0 text-xl font-bold tracking-tight text-(--ui-primary)">
          LIBRARY
        </NuxtLink>

        <nav class="flex grow items-center gap-6">
          <NuxtLink
            v-for="link in links"
            :key="link.to"
            :to="link.to"
            class="text-sm transition-colors"
            :class="isActive(link.to) ? 'font-semibold text-white' : 'text-white/70 hover:text-white'"
          >
            {{ link.label }}
          </NuxtLink>
        </nav>

        <UDropdownMenu
          v-if="user"
          :items="[[
            ...(isAdmin ? [{ label: 'Manage library', icon: 'i-lucide-sliders-horizontal', to: '/admin' }] : []),
            { label: 'Sign out', icon: 'i-lucide-log-out', onSelect: signOut },
          ]]"
        >
          <button type="button" class="flex items-center gap-2 text-sm text-white/80 hover:text-white">
            <span
              class="grid size-8 place-items-center rounded bg-red-700 text-xs font-bold text-white"
            >
              {{ user.displayName.slice(0, 2).toUpperCase() }}
            </span>
            <UIcon name="i-lucide-chevron-down" class="size-4" />
          </button>
        </UDropdownMenu>
      </div>
    </header>

    <main>
      <slot />
    </main>
  </div>
</template>
