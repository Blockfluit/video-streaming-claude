<script setup lang="ts">
/**
 * The signed-in shell. The two auth pages opt out with `layout: false` — a nav
 * bar offering "Browse" to someone who cannot browse yet is just noise.
 */
const { user } = useSession()
const api = useApi()

// Only what exists. The admin section and the collection pages arrive with
// their own slices — a nav link to a route with no page is a broken app, not a
// placeholder.
const links = [
  { label: 'Home', to: '/' },
  { label: 'Browse', to: '/browse' },
  { label: 'My List', to: '/my-list' },
  { label: 'History', to: '/history' },
]

async function signOut() {
  await api('/auth/logout', { method: 'POST' })
  user.value = null
  await navigateTo('/login')
}
</script>

<template>
  <div class="min-h-screen flex flex-col">
    <header class="border-b border-(--ui-border) sticky top-0 z-10 bg-(--ui-bg)/85 backdrop-blur">
      <UContainer class="flex items-center gap-6 h-14">
        <NuxtLink to="/" class="font-semibold shrink-0">Library</NuxtLink>

        <nav class="flex items-center gap-1 grow">
          <UButton
            v-for="link in links"
            :key="link.to"
            :to="link.to"
            variant="ghost"
            color="neutral"
            size="sm"
          >
            {{ link.label }}
          </UButton>
        </nav>

        <UDropdownMenu
          v-if="user"
          :items="[[{ label: 'Sign out', icon: 'i-lucide-log-out', onSelect: signOut }]]"
        >
          <UButton variant="ghost" color="neutral" size="sm" trailing-icon="i-lucide-chevron-down">
            {{ user.displayName }}
          </UButton>
        </UDropdownMenu>
      </UContainer>
    </header>

    <main class="grow">
      <slot />
    </main>
  </div>
</template>
