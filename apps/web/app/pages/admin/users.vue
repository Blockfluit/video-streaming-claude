<script setup lang="ts">
import { DEFAULT_INVITE_TTL_HOURS, MAX_INVITE_TTL_HOURS, type Page } from '@video/shared'

/**
 * Accounts and invite tokens.
 *
 * A minted token is shown **once** and never again — only its hash is stored,
 * so there is no way to retrieve it later. The copy button is the feature.
 *
 * The invite table is an audit surface: the row is the only record of who
 * invited whom and whether it was ever used, which is why revoking soft-deletes
 * rather than dropping it.
 */
definePageMeta({ layout: 'admin', middleware: 'admin' })

interface Account {
  id: string
  username: string
  displayName: string
  role: 'ADMIN' | 'USER'
  isActive: boolean
  createdAt: string
}

/** Whoever minted a token, or whoever spent it. */
interface InvitePerson {
  id: string
  displayName: string
  username: string
}

interface Invite {
  id: string
  kind: 'BOOTSTRAP' | 'INVITE'
  grantsRole: 'ADMIN' | 'USER'
  /** Computed by the API, not a column — `redeemed → revoked → expired`. */
  state: 'VALID' | 'REDEEMED' | 'REVOKED' | 'EXPIRED'
  expiresAt: string
  redeemedAt: string | null
  revokedAt: string | null
  createdAt: string
  createdBy: InvitePerson | null
  redeemedUser: InvitePerson | null
}

/**
 * Green means *this one can still let someone in*. With four states there is
 * only one colour worth spending on the state you can still act on, so a spent
 * token is grey rather than green — the "used by" and "redeemed" columns are
 * what carry its story.
 */
const STATE_TONE: Record<string, string> = {
  VALID: 'success',
  REDEEMED: 'neutral',
  REVOKED: 'error',
  EXPIRED: 'warning',
}

/**
 * Presets rather than a free-form number of hours: nothing to mistype, and no
 * way to send a value the API will refuse. The ends come from the shared
 * constants because they are the API's bounds, not this form's.
 */
const EXPIRY_OPTIONS = [
  { label: '24 hours', value: 24 },
  { label: '7 days', value: DEFAULT_INVITE_TTL_HOURS },
  { label: '30 days', value: 30 * 24 },
  { label: '90 days', value: MAX_INVITE_TTL_HOURS },
]

const ROLE_OPTIONS = [
  { label: 'Viewer', value: 'USER' },
  { label: 'Admin', value: 'ADMIN' },
]

/**
 * Sorting Status alphabetically puts VALID last, which is the one state an
 * admin can still act on. Ranked instead: live first, then the two ways a token
 * was stopped, then the ones that did their job.
 */
const STATE_RANK: Record<string, number> = { VALID: 0, EXPIRED: 1, REVOKED: 2, REDEEMED: 3 }

/**
 * The header row, and what each column sorts on.
 *
 * `value` returns what the cell *means* rather than what it renders: a date
 * becomes a number so it orders chronologically instead of alphabetically, and
 * a person becomes their display name. Returning null means "nothing here",
 * which `compareValues` pins to the bottom whichever way the arrow points.
 */
const COLUMNS: { key: string, label: string, value: (invite: Invite) => SortValue }[] = [
  { key: 'kind', label: 'Kind', value: invite => invite.kind },
  { key: 'grants', label: 'Grants', value: invite => invite.grantsRole },
  {
    key: 'createdBy',
    label: 'Created by',
    value: invite => invite.createdBy?.displayName ?? creatorLabel(invite),
  },
  { key: 'created', label: 'Created', value: invite => Date.parse(invite.createdAt) },
  { key: 'status', label: 'Status', value: invite => STATE_RANK[invite.state] ?? 99 },
  { key: 'redeemedBy', label: 'Used by', value: invite => invite.redeemedUser?.displayName ?? null },
  {
    key: 'redeemed',
    label: 'Redeemed',
    value: invite => (invite.redeemedAt === null ? null : Date.parse(invite.redeemedAt)),
  },
]

// Matching the API's own order, so the first paint is the one the server sent.
const sortKey = ref('created')
const sortDirection = ref<SortDirection>('desc')

function sortBy(key: string) {
  if (sortKey.value === key) {
    sortDirection.value = sortDirection.value === 'asc' ? 'desc' : 'asc'
    return
  }

  sortKey.value = key
  // A fresh column starts ascending, except the dates: asking for "Created"
  // almost always means the newest, and starting at the oldest invite ever
  // minted makes every date column take two clicks.
  sortDirection.value = key === 'created' || key === 'redeemed' ? 'desc' : 'asc'
}

const api = useApi()
const toast = useToast()
const { user } = useSession()

const { data: users, refresh: refreshUsers } = await useApiData<Page<Account>>(
  'admin-users',
  '/admin/users?limit=100',
)
const { data: invites, refresh: refreshInvites } = await useApiData<Page<Invite>>(
  'admin-invites',
  '/admin/invites?limit=100',
)

/**
 * Sorted in the browser, over the page the API already sent. That is honest
 * while everything fits in one request and misleading the moment it does not,
 * which is what the count below the table is for.
 */
const sortedInvites = computed(() => {
  const column = COLUMNS.find(entry => entry.key === sortKey.value)
  const rows = [...(invites.value?.items ?? [])]

  if (!column) return rows

  return rows.sort(
    (a, b) =>
      compareValues(column.value(a), column.value(b), sortDirection.value)
      // `id` last, so the order is total. Without it, rows that tie are free to
      // swap places on every re-render, which reads as a rendering bug for
      // weeks before anyone suspects the sort.
      || a.id.localeCompare(b.id),
  )
})

/** True once the API is holding invites this page never asked for. */
const truncated = computed(
  () => (invites.value?.total ?? 0) > (invites.value?.items?.length ?? 0),
)

/** Held in memory only. Navigating away loses it, which is the point. */
const freshToken = ref<string | null>(null)

/**
 * The token as something you can send someone. `/setup` reads this parameter
 * and prefills the field, so the recipient has one thing to click rather than a
 * 43-character string to copy out of a message without clipping an edge.
 *
 * Built from `window.location.origin` rather than a configured base URL,
 * because whichever hostname the admin reached this page on is the one that
 * will work for them to share. Client-only by construction: the alert only
 * exists after a mint, which only happens in the browser.
 */
const inviteLink = computed(() =>
  freshToken.value && import.meta.client
    ? `${window.location.origin}/setup?token=${encodeURIComponent(freshToken.value)}`
    : null,
)

const expiresInHours = ref<number>(DEFAULT_INVITE_TTL_HOURS)
const grantsRole = ref<string>('USER')
const minting = ref(false)

/** The invite a revoke is being confirmed for. */
const confirming = ref<Invite | null>(null)
const revoking = ref(false)

/** UModal writes its own open state, so it needs a boolean of its own. */
const confirmingOpen = computed({
  get: () => confirming.value !== null,
  set: (open: boolean) => {
    if (!open) confirming.value = null
  },
})

/**
 * A null minter means two different things, and neither is missing data.
 * BOOTSTRAP is minted at startup with no admin present; anything else lost its
 * creator when that account was deleted. An em dash here would read as a bug.
 */
function creatorLabel(invite: Invite): string {
  return invite.kind === 'BOOTSTRAP' ? 'system' : 'deleted account'
}

/**
 * Expiry earns no column of its own — it says something in only two of the four
 * states, and the one it says nothing about already has a column for its date.
 */
function statusDetail(invite: Invite): string | null {
  if (invite.state === 'VALID') return `expires ${shortDate(invite.expiresAt) ?? '—'}`
  if (invite.state === 'EXPIRED') return `expired ${shortDate(invite.expiresAt) ?? '—'}`
  if (invite.state === 'REVOKED') return `revoked ${shortDate(invite.revokedAt) ?? '—'}`

  return null
}

async function mint() {
  minting.value = true
  try {
    const response = await api<{ token: string }>('/admin/invites', {
      method: 'POST',
      body: { expiresInHours: expiresInHours.value, grantsRole: grantsRole.value },
    })
    freshToken.value = response.token
    await refreshInvites()
  } catch (error) {
    toast.add({ title: apiMessage(error, 'Could not mint an invite.'), color: 'error' })
  } finally {
    minting.value = false
  }
}

async function copy(value: string | null, what: string) {
  if (!value) return
  await navigator.clipboard.writeText(value)
  toast.add({ title: `${what} copied`, color: 'success' })
}

async function revoke(invite: Invite) {
  revoking.value = true
  try {
    await api(`/admin/invites/${invite.id}`, { method: 'DELETE' })
    confirming.value = null
    await refreshInvites()
    toast.add({ title: 'Invite revoked', color: 'success' })
  } catch (error) {
    // A 404 here means it was spent or revoked between this list loading and
    // the click — the server's own words say which.
    toast.add({ title: apiMessage(error, 'Could not revoke that invite.'), color: 'error' })
  } finally {
    revoking.value = false
  }
}

async function update(account: Account, body: Record<string, unknown>) {
  try {
    await api(`/admin/users/${account.id}`, { method: 'PATCH', body })
    await refreshUsers()
  } catch (error) {
    // The API refuses to strand the library without an admin — demote,
    // deactivate or delete the last one and this is the message.
    toast.add({ title: apiMessage(error, 'That change was refused.'), color: 'error' })
  }
}

useHead({ title: 'Accounts' })
</script>

<template>
  <div class="space-y-8">
    <div>
      <h1 class="text-2xl font-bold tracking-tight">Accounts</h1>
      <p class="text-sm text-(--ui-text-muted)">There is no sign-up. People get in by invite.</p>
    </div>

    <UCard>
      <template #header><h2 class="font-semibold">Invites</h2></template>

      <div class="mb-4 flex flex-wrap items-end gap-2">
        <UFormField label="Expires in">
          <!--
            An explicit aria-label on every @nuxt/ui trigger: the component ships
            one of its own that shadows the visible label, so without this the
            accessible name of the control describes the popup, not the job.
          -->
          <USelect
            v-model="expiresInHours"
            :items="EXPIRY_OPTIONS"
            aria-label="How long the invite lasts"
            class="w-full sm:w-40"
          />
        </UFormField>
        <UFormField label="Grants">
          <USelect
            v-model="grantsRole"
            :items="ROLE_OPTIONS"
            aria-label="Role the invite grants"
            class="w-full sm:w-32"
          />
        </UFormField>
        <UButton icon="i-lucide-plus" :loading="minting" @click="mint">Mint a token</UButton>
      </div>

      <UAlert
        v-if="freshToken"
        color="primary"
        variant="subtle"
        icon="i-lucide-key-round"
        class="mb-4"
        title="Copy this now — it is not shown again"
      >
        <template #description>
          <div class="mt-2 space-y-3">
            <div>
              <p class="mb-1 text-xs">Invite link — send this</p>
              <div class="flex items-center gap-2">
                <!--
                  An anchor, not a second `<code>`: the mint test locates the
                  token with a bare `page.locator('code')`, which is strict, so
                  a second one fails it with a strict violation rather than a
                  readable assertion.
                -->
                <a
                  :href="inviteLink ?? '#'"
                  class="grow rounded bg-black/40 px-2 py-1 font-mono text-xs break-all underline underline-offset-2"
                >{{ inviteLink }}</a>
                <UButton
                  size="xs"
                  icon="i-lucide-copy"
                  aria-label="Copy the invite link"
                  @click="copy(inviteLink, 'Invite link')"
                >
                  Copy
                </UButton>
              </div>
            </div>

            <div>
              <p class="mb-1 text-xs">Or the token on its own</p>
              <div class="flex items-center gap-2">
                <code class="grow rounded bg-black/40 px-2 py-1 font-mono text-xs break-all">
                  {{ freshToken }}
                </code>
                <UButton
                  size="xs"
                  icon="i-lucide-copy"
                  aria-label="Copy the token"
                  @click="copy(freshToken, 'Token')"
                >
                  Copy
                </UButton>
              </div>
            </div>
          </div>
        </template>
      </UAlert>

      <!--
        Eight columns will not fit a narrow viewport; the nowrap cells arm the
        horizontal scroll.

        The height cap is what makes the sticky header work rather than a
        flourish on top of it. Setting `overflow-x` to anything but `visible`
        makes `overflow-y` compute to `auto` as well, so this div was already a
        vertical scroll container — just an unbounded one, which scrolled with
        the page and left a sticky header nothing to stick to. Capping it gives
        the header a scrollport of its own.
      -->
      <div v-if="invites?.items?.length" class="scroll-pane max-h-[65vh] overflow-auto">
        <table aria-label="Invites" class="w-full text-sm">
          <thead class="sticky top-0 z-10 border-b border-(--ui-border) bg-(--ui-bg-elevated) text-left text-xs text-(--ui-text-muted) uppercase">
            <tr>
              <!--
                `aria-sort` on the cell and a real button inside it: the header
                is the control, and a screen reader announcing "Created,
                descending" is the only way that state exists for someone not
                looking at the arrow.
              -->
              <th
                v-for="column in COLUMNS"
                :key="column.key"
                :aria-sort="sortKey === column.key
                  ? (sortDirection === 'asc' ? 'ascending' : 'descending')
                  : 'none'"
                class="p-0"
              >
                <button
                  type="button"
                  class="flex w-full items-center gap-1 p-3 text-left uppercase transition-colors hover:text-(--ui-text-highlighted)"
                  @click="sortBy(column.key)"
                >
                  {{ column.label }}
                  <!--
                    The slot is always there and the arrow only sometimes, so
                    the labels do not shift by twelve pixels when the sort
                    moves. Not `opacity-0`: an invisible element that is still
                    laid out is the thing the contrast audit exists to catch,
                    and an icon's colour is its background, so a transparent one
                    measures against itself.
                  -->
                  <span class="flex size-3 shrink-0 items-center justify-center">
                    <UIcon
                      v-if="sortKey === column.key"
                      :name="sortDirection === 'asc'
                        ? 'i-lucide-chevron-up'
                        : 'i-lucide-chevron-down'"
                      class="size-3"
                      aria-hidden="true"
                    />
                  </span>
                </button>
              </th>
              <th class="p-3" />
            </tr>
          </thead>
          <tbody class="divide-y divide-(--ui-border)">
            <tr v-for="invite in sortedInvites" :key="invite.id" class="hover:bg-white/[0.03]">
              <td class="p-3">
                <UBadge color="neutral" variant="subtle" size="sm">{{ invite.kind }}</UBadge>
              </td>

              <td class="p-3">
                <UBadge
                  :color="invite.grantsRole === 'ADMIN' ? 'primary' : 'neutral'"
                  variant="subtle"
                  size="sm"
                >
                  {{ invite.grantsRole }}
                </UBadge>
              </td>

              <td class="p-3">
                <template v-if="invite.createdBy">
                  <p class="font-medium">{{ invite.createdBy.displayName }}</p>
                  <p class="text-xs text-(--ui-text-muted)">{{ invite.createdBy.username }}</p>
                </template>
                <span v-else class="text-(--ui-text-muted)">{{ creatorLabel(invite) }}</span>
              </td>

              <td class="p-3 whitespace-nowrap text-(--ui-text-muted)">
                {{ shortDate(invite.createdAt) }}
              </td>

              <td class="p-3 whitespace-nowrap">
                <UBadge
                  :color="(STATE_TONE[invite.state] as any) ?? 'neutral'"
                  variant="subtle"
                  size="sm"
                >
                  {{ invite.state }}
                </UBadge>
                <p v-if="statusDetail(invite)" class="mt-1 text-xs text-(--ui-text-muted)">
                  {{ statusDetail(invite) }}
                </p>
              </td>

              <td class="p-3">
                <template v-if="invite.redeemedUser">
                  <p class="font-medium">{{ invite.redeemedUser.displayName }}</p>
                  <p class="text-xs text-(--ui-text-muted)">{{ invite.redeemedUser.username }}</p>
                </template>
                <span v-else class="text-(--ui-text-muted)">—</span>
              </td>

              <td class="p-3 whitespace-nowrap text-(--ui-text-muted)">
                {{ shortDate(invite.redeemedAt) ?? '—' }}
              </td>

              <td class="p-3 text-right">
                <!--
                  Only a VALID token can be revoked to any effect. An expired one
                  still has both columns null, so the API would take it, but
                  `tokenState` already refuses it and nothing on screen changes.
                -->
                <UButton
                  v-if="invite.state === 'VALID'"
                  size="xs"
                  color="error"
                  variant="subtle"
                  icon="i-lucide-ban"
                  :aria-label="`Revoke invite created ${dateTime(invite.createdAt)}`"
                  @click="confirming = invite"
                >
                  Revoke
                </UButton>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="text-sm text-(--ui-text-muted)">No invites yet.</p>

      <!--
        Sorting happens in the browser, over the rows already fetched. Say so
        when there are more, rather than letting "oldest first" quietly mean
        "oldest of the hundred most recent".
      -->
      <p v-if="truncated" class="mt-3 text-xs text-(--ui-text-muted)">
        Showing the {{ invites?.items?.length }} most recently created of
        {{ invites?.total }}. Sorting reorders these, not the rest.
      </p>
    </UCard>

    <UCard>
      <template #header><h2 class="font-semibold">People</h2></template>
      <!--
        The one table in the admin with no scroll container at all. Four
        columns ending in two full-text buttons ("Make viewer", "Disable") do
        not fit 343px, and without this the row simply ran off the card.
      -->
      <div class="table-scroll">
        <table class="w-full min-w-max text-sm">
          <tbody class="divide-y divide-(--ui-border)">
            <tr v-for="account in users?.items ?? []" :key="account.id">
              <td class="py-3">
                <p class="font-medium">
                  {{ account.displayName }}
                  <span v-if="account.id === user?.id" class="text-xs text-(--ui-text-muted)">(you)</span>
                </p>
                <p class="text-xs text-(--ui-text-muted)">{{ account.username }}</p>
              </td>
              <td class="py-3">
                <UBadge :color="account.role === 'ADMIN' ? 'primary' : 'neutral'" variant="subtle">
                  {{ account.role }}
                </UBadge>
              </td>
              <td class="py-3">
                <UBadge :color="account.isActive ? 'success' : 'error'" variant="subtle">
                  {{ account.isActive ? 'active' : 'disabled' }}
                </UBadge>
              </td>
              <td class="py-3 text-right">
                <div class="flex justify-end gap-2">
                  <UButton
                    size="xs"
                    color="neutral" variant="subtle"
                    @click="update(account, { role: account.role === 'ADMIN' ? 'USER' : 'ADMIN' })"
                  >
                    Make {{ account.role === 'ADMIN' ? 'viewer' : 'admin' }}
                  </UButton>
                  <UButton
                    size="xs"
                    variant="subtle"
                    :color="account.isActive ? 'error' : 'neutral'"
                    @click="update(account, { isActive: !account.isActive })"
                  >
                    {{ account.isActive ? 'Disable' : 'Enable' }}
                  </UButton>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </UCard>

    <!--
      The title states the situation rather than asking "are you sure?", and the
      button names the consequence. Revoking destroys nothing — the row survives
      as the record of who invited whom — but there is no un-revoke, and that is
      what earns a dialog here.
    -->
    <UModal v-model:open="confirmingOpen" title="This invite can still be used">
      <template #body>
        <div v-if="confirming" class="space-y-3 text-sm">
          <p>
            Minted by
            <strong>{{ confirming.createdBy?.displayName ?? creatorLabel(confirming) }}</strong>
            on {{ shortDate(confirming.createdAt) }}, granting
            <strong>{{ confirming.grantsRole }}</strong>. It expires on
            {{ shortDate(confirming.expiresAt) }}.
          </p>
          <p class="text-(--ui-text-muted)">
            Anyone holding this token can create an account with it until then.
            Revoking stops that immediately and cannot be undone — minting a
            replacement is the only way back.
          </p>
          <p class="text-(--ui-text-muted)">
            The invite stays in this list either way. It is the only record of
            who invited whom.
          </p>
        </div>
      </template>
      <template #footer>
        <div class="flex w-full gap-2">
          <UButton color="neutral" variant="subtle" @click="confirming = null">Cancel</UButton>
          <UButton
            class="ml-auto"
            color="error"
            :loading="revoking"
            @click="confirming && revoke(confirming)"
          >
            Revoke this invite
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
