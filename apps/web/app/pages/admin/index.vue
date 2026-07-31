<script setup lang="ts">
import type { Page } from '@video/shared'

/**
 * The overview: what needs a person's attention, and nothing else.
 *
 * Every tile is a count that should normally be zero or a link to work in
 * progress. A dashboard of vanity totals gets ignored within a week.
 */
definePageMeta({ layout: 'admin', middleware: 'admin' })

interface Counted { total: number }

const [{ data: drafts }, { data: missing }, { data: issues }, { data: jobs }, { data: needsConvert }] =
  await Promise.all([
    useApiData<Counted>('adm-drafts', '/videos?state=DRAFT&limit=1'),
    useApiData<Counted>('adm-missing', '/videos?state=MISSING&limit=1'),
    useApiData<Counted>('adm-issues', '/admin/ingest/issues?limit=1'),
    useApiData<Counted>('adm-jobs', '/admin/jobs?status=RUNNING&limit=1'),
    useApiData<Page<{ id: string }>>('adm-published', '/videos?state=PUBLISHED&limit=1'),
  ])

const tiles = computed(() => [
  {
    label: 'Drafts waiting',
    value: drafts.value?.total ?? 0,
    to: '/admin/drafts',
    icon: 'i-lucide-inbox',
    tone: (drafts.value?.total ?? 0) > 0 ? 'primary' : 'neutral',
  },
  {
    label: 'Files missing',
    value: missing.value?.total ?? 0,
    to: '/admin/library?state=MISSING',
    icon: 'i-lucide-file-x',
    tone: (missing.value?.total ?? 0) > 0 ? 'error' : 'neutral',
  },
  {
    label: 'Ingest issues',
    value: issues.value?.total ?? 0,
    to: '/admin/ingest',
    icon: 'i-lucide-triangle-alert',
    tone: (issues.value?.total ?? 0) > 0 ? 'warning' : 'neutral',
  },
  {
    label: 'Jobs running',
    value: jobs.value?.total ?? 0,
    to: '/admin/jobs',
    icon: 'i-lucide-cpu',
    tone: 'neutral',
  },
  {
    label: 'Published',
    value: needsConvert.value?.total ?? 0,
    to: '/admin/library',
    icon: 'i-lucide-check-check',
    tone: 'neutral',
  },
])
</script>

<template>
  <div class="space-y-8">
    <div>
      <h1 class="text-2xl font-bold tracking-tight">Manage library</h1>
      <p class="text-sm text-white/50">Everything that needs a decision.</p>
    </div>

    <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      <NuxtLink
        v-for="tile in tiles"
        :key="tile.label"
        :to="tile.to"
        class="group rounded-lg border border-white/5 bg-(--ui-bg-elevated) p-5 transition-colors hover:border-white/15"
      >
        <div class="flex items-center gap-3">
          <UIcon
            :name="tile.icon"
            class="size-5"
            :class="{
              'text-(--ui-primary)': tile.tone === 'primary',
              'text-red-400': tile.tone === 'error',
              'text-amber-400': tile.tone === 'warning',
              'text-white/40': tile.tone === 'neutral',
            }"
          />
          <span class="text-sm text-white/60">{{ tile.label }}</span>
          <UIcon
            name="i-lucide-arrow-right"
            class="ml-auto size-4 text-white/20 transition-transform group-hover:translate-x-0.5"
          />
        </div>
        <p class="mt-3 text-3xl font-semibold tabular-nums">{{ tile.value }}</p>
      </NuxtLink>
    </div>

    <div class="grid gap-3 sm:grid-cols-2">
      <UButton to="/admin/upload" icon="i-lucide-upload" size="lg" variant="subtle" block>
        Upload a video
      </UButton>
      <UButton to="/admin/ingest" icon="i-lucide-folder-sync" size="lg" variant="subtle" block>
        Scan the media folder
      </UButton>
    </div>
  </div>
</template>
