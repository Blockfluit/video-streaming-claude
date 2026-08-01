<script setup lang="ts">
/**
 * The management shell.
 *
 * Deliberately a different surface from the viewer app: a sidebar, denser
 * spacing, no hero. Someone triaging two hundred draft videos is doing a
 * different job from someone deciding what to watch, and the chrome should not
 * pretend otherwise.
 */
const route = useRoute()
const { user } = useSession()
const api = useApi()

const sections = [
  { label: 'Overview', to: '/admin', icon: 'i-lucide-layout-dashboard' },
  { label: 'Drafts', to: '/admin/drafts', icon: 'i-lucide-inbox' },
  { label: 'Library', to: '/admin/library', icon: 'i-lucide-library' },
  { label: 'Upload', to: '/admin/upload', icon: 'i-lucide-upload' },
  { label: 'Jobs', to: '/admin/jobs', icon: 'i-lucide-cpu' },
  { label: 'Ingest', to: '/admin/ingest', icon: 'i-lucide-folder-sync' },
  { label: 'Curated rows', to: '/admin/lists', icon: 'i-lucide-rows-3' },
  { label: 'Comments', to: '/admin/comments', icon: 'i-lucide-message-square' },
  { label: 'People', to: '/admin/people', icon: 'i-lucide-users' },
  { label: 'Accounts', to: '/admin/users', icon: 'i-lucide-key-round' },
]

const isActive = (to: string) =>
  to === '/admin' ? route.path === '/admin' : route.path.startsWith(to)

async function signOut() {
  await api('/auth/logout', { method: 'POST' })
  user.value = null
  await navigateTo('/login')
}
</script>

<template>
  <div class="min-h-screen bg-(--ui-bg)">
    <div class="page-shell flex gap-8 pt-10 pb-16">
      <aside class="sticky top-6 hidden h-fit w-56 shrink-0 space-y-1 lg:block">
        <NuxtLink to="/" class="mb-4 flex items-center gap-2 px-3 text-sm text-(--ui-text-muted) hover:text-(--ui-text-highlighted)">
          <UIcon name="i-lucide-arrow-left" class="size-4" />
          Back to the library
        </NuxtLink>

        <NuxtLink
          v-for="section in sections"
          :key="section.to"
          :to="section.to"
          class="flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors"
          :class="isActive(section.to)
            ? 'bg-(--ui-bg-accented) font-medium text-(--ui-text-highlighted)'
            : 'text-(--ui-text-muted) hover:bg-(--ui-bg-elevated) hover:text-(--ui-text-highlighted)'"
        >
          <!--
            The selected row is marked by a rule and a raised surface, not by
            colouring the label red. Red-on-black clears WCAG and still reads
            badly at 14px, which is what made the whole sidebar feel dim.
          -->
          <span
            aria-hidden="true"
            class="-ml-1 h-4 w-0.5 rounded-full transition-colors"
            :class="isActive(section.to) ? 'bg-(--ui-primary)' : 'bg-transparent'"
          />
          <UIcon :name="section.icon" class="size-4 shrink-0" />
          {{ section.label }}
        </NuxtLink>

        <USeparator class="my-3" />
        <button
          type="button"
          class="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-(--ui-text-muted) hover:bg-(--ui-bg-elevated) hover:text-(--ui-text-highlighted)"
          @click="signOut"
        >
          <UIcon name="i-lucide-log-out" class="size-4" />
          Sign out
        </button>
      </aside>

      <!--
        A real landmark, not a bare div. The admin screens had no <main>
        at all, so assistive technology offered no way to skip the nav and
        "the main content" was not addressable — the viewer layout has had
        one all along.
      -->
      <main class="min-w-0 grow">
        <!-- The sidebar is hidden below lg; this is the way back on a phone. -->
        <div class="mb-4 flex gap-2 overflow-x-auto lg:hidden">
          <UButton
            v-for="section in sections"
            :key="section.to"
            :to="section.to"
            size="xs"
            :color="isActive(section.to) ? 'primary' : 'neutral'"
            variant="subtle"
          >
            {{ section.label }}
          </UButton>
        </div>

        <slot />
      </main>
    </div>
  </div>
</template>
