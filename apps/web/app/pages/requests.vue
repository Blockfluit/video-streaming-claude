<script setup lang="ts">
import {
  MAX_REQUEST_COMMENT_LENGTH,
  MAX_REQUEST_TITLE_LENGTH,
  type Page,
} from '@video/shared'

/**
 * Asking for something the library does not have, and seeing what came of it.
 *
 * The list is everyone's requests, not just yours — knowing something has
 * already been asked for is most of the value — but **without the names**. The
 * API decides that; this page could not show them if it wanted to. Your own
 * entries are marked, because a page that has hidden every name has also hidden
 * yours.
 */
const api = useApi()
const toast = useToast()

const title = ref('')
const year = ref<string>('')
const comment = ref('')
const submitting = ref(false)

/**
 * A number input hands back a string, and an emptied one hands back `''`.
 *
 * `yearSchema` is a `z.coerce.number()`, which turns `''` into `0` and then
 * refuses it for being before 1888 — so clearing the field would fail with a
 * message about the first film ever shot. Anything that is not a real number
 * becomes an honest `null` here instead.
 */
const yearValue = computed<number | null>(() => {
  const parsed = Number.parseInt(year.value, 10)
  return Number.isFinite(parsed) ? parsed : null
})

/** The refusal that comes with something to click, rather than only a message. */
const clash = ref<{ message: string, path: string | null } | null>(null)

const statusFilter = ref<string>(ANY_STATUS)
const mineOnly = ref(false)

const query = computed(() => {
  const params = new URLSearchParams({ limit: '100' })
  if (statusFilter.value !== ANY_STATUS) params.set('status', statusFilter.value)
  // booleanParam on the API side: "false" really is false.
  if (mineOnly.value) params.set('mine', 'true')
  return params.toString()
})

const { data, refresh } = await useApiData<Page<RequestView>>(
  'requests',
  () => `/requests?${query.value}`,
  { watch: [query] },
)

const requests = computed(() => data.value?.items ?? [])

/**
 * Where the thing we clashed with actually lives, built with the same helpers
 * every other link on the site uses rather than a string the API made up.
 */
function matchPath(match: RequestView['libraryMatch']): string | null {
  if (!match) return null

  return match.kind === 'collection'
    ? collectionPath(match)
    : watchPath({ slug: match.slug, collection: match.collection, season: match.season })
}

async function submit() {
  if (!title.value.trim()) return

  submitting.value = true
  clash.value = null

  try {
    await api('/requests', {
      method: 'POST',
      body: {
        title: title.value,
        year: yearValue.value,
        comment: comment.value,
      },
    })

    title.value = ''
    year.value = ''
    comment.value = ''
    await refresh()
    toast.add({ title: 'Requested', color: 'success' })
  }
  catch (error) {
    const data = (error as { data?: { reason?: string, match?: RequestView['libraryMatch'] } })?.data

    /*
     * A 409 is the normal answer to "we already have this", not a failure — so
     * it lands in the form next to the title, with a way to go and look, rather
     * than in a toast that disappears.
     */
    if (data?.reason === 'ALREADY_IN_LIBRARY' || data?.reason === 'ALREADY_REQUESTED') {
      clash.value = {
        message: apiMessage(error, 'That has already been asked for.'),
        path: matchPath(data.match ?? null),
      }
    }
    else {
      toast.add({ title: apiMessage(error, 'Could not send that.'), color: 'error' })
    }
  }
  finally {
    submitting.value = false
  }
}

async function withdraw(request: RequestView) {
  try {
    await api(`/requests/${request.id}`, { method: 'DELETE' })
    await refresh()
    toast.add({ title: 'Request withdrawn', color: 'success' })
  }
  catch (error) {
    toast.add({ title: apiMessage(error, 'Could not withdraw that.'), color: 'error' })
  }
}

function when(iso: string): string {
  return new Date(iso).toLocaleDateString()
}

useHead({ title: 'Requests' })
</script>

<template>
  <div class="page-shell space-y-8 pt-24 pb-16">
    <div>
      <h1 class="text-2xl font-semibold">Requests</h1>
      <p class="mt-1 text-sm text-(--ui-text-muted)">
        Ask for something that is not here yet. Requests are shown to everyone
        without names.
      </p>
    </div>

    <!-- The form. Only the title is required. -->
    <section class="rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-5">
      <form class="space-y-4" @submit.prevent="submit">
        <div class="flex flex-col gap-4 sm:flex-row">
          <UFormField label="Title" required class="grow">
            <UInput
              v-model="title"
              :maxlength="MAX_REQUEST_TITLE_LENGTH"
              placeholder="What would you like to watch?"
              class="w-full"
            />
          </UFormField>

          <UFormField label="Year" hint="Optional" class="sm:w-36">
            <UInput
              v-model="year"
              type="number"
              placeholder="1999"
              class="w-full"
            />
          </UFormField>
        </div>

        <UFormField label="Anything else?" hint="Optional">
          <UTextarea
            v-model="comment"
            :maxlength="MAX_REQUEST_COMMENT_LENGTH"
            :rows="2"
            placeholder="A particular version, subtitles, why you want it…"
            class="w-full"
          />
        </UFormField>

        <!--
          The clash sits in the form, beside what caused it. A toast would take
          the one piece of information worth acting on and hide it after four
          seconds.
        -->
        <UAlert
          v-if="clash"
          color="warning"
          variant="subtle"
          icon="i-lucide-info"
          :title="clash.message"
        >
          <template v-if="clash.path" #description>
            <NuxtLink :to="clash.path" class="underline">Go and have a look</NuxtLink>
          </template>
        </UAlert>

        <div class="flex justify-end">
          <UButton
            type="submit"
            variant="solid"
            :loading="submitting"
            :disabled="!title.trim()"
          >
            Request it
          </UButton>
        </div>
      </form>
    </section>

    <!-- The list. -->
    <section class="space-y-4">
      <div class="flex flex-wrap items-center gap-3">
        <h2 class="text-lg font-semibold">What has been asked for</h2>

        <USelect
          v-model="statusFilter"
          :items="requestStatusFilterOptions"
          aria-label="Filter requests by status"
          class="ml-auto w-44"
        />
        <UCheckbox v-model="mineOnly" label="Only mine" />
      </div>

      <div v-if="requests.length" class="space-y-2">
        <article
          v-for="request in requests"
          :key="request.id"
          class="rounded-lg border border-(--ui-border) bg-(--ui-bg-elevated) p-4"
        >
          <div class="flex flex-wrap items-center gap-2">
            <h3 class="font-medium">{{ request.title }}</h3>
            <span v-if="request.year" class="text-sm text-(--ui-text-muted)">
              {{ request.year }}
            </span>

            <UBadge
              :color="requestStatusColour(request.status)"
              variant="subtle"
              size="sm"
            >
              {{ requestStatusLabel(request.status) }}
            </UBadge>
            <UBadge v-if="request.mine" color="neutral" variant="subtle" size="sm">
              yours
            </UBadge>

            <span class="text-sm text-(--ui-text-dimmed)">{{ when(request.createdAt) }}</span>

            <UButton
              v-if="request.mine"
              class="ml-auto"
              size="xs"
              color="neutral"
              variant="subtle"
              icon="i-lucide-x"
              :aria-label="`Withdraw your request for ${request.title}`"
              @click="withdraw(request)"
            >
              Withdraw
            </UButton>
          </div>

          <p v-if="request.comment" class="mt-2 text-sm whitespace-pre-wrap text-(--ui-text)">
            {{ request.comment }}
          </p>

          <p v-if="request.adminNote" class="mt-2 text-sm text-(--ui-text-muted)">
            <span class="font-medium text-(--ui-text)">Reply:</span>
            {{ request.adminNote }}
          </p>
        </article>
      </div>

      <p v-else class="py-16 text-center text-(--ui-text-muted)">
        {{ mineOnly ? 'You have not requested anything yet.' : 'Nothing has been requested yet.' }}
      </p>
    </section>
  </div>
</template>
