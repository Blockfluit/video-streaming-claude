<script setup lang="ts">
import type { Page } from '@video/shared'

/**
 * Accounts and invite tokens.
 *
 * A minted token is shown **once** and never again — only its hash is stored,
 * so there is no way to retrieve it later. The copy button is the feature.
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

interface Invite {
  id: string
  kind: string
  expiresAt: string | null
  redeemedAt: string | null
  createdAt: string
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

/** Held in memory only. Navigating away loses it, which is the point. */
const freshToken = ref<string | null>(null)

async function mint() {
  try {
    const response = await api<{ token: string }>('/admin/invites', { method: 'POST', body: {} })
    freshToken.value = response.token
    await refreshInvites()
  } catch {
    toast.add({ title: 'Could not mint an invite.', color: 'error' })
  }
}

async function copy() {
  if (!freshToken.value) return
  await navigator.clipboard.writeText(freshToken.value)
  toast.add({ title: 'Copied', color: 'success' })
}

async function update(account: Account, body: Record<string, unknown>) {
  try {
    await api(`/admin/users/${account.id}`, { method: 'PATCH', body })
    await refreshUsers()
  } catch (error) {
    // The API refuses to strand the library without an admin — demote,
    // deactivate or delete the last one and this is the message.
    const data = (error as { data?: { message?: string } }).data
    toast.add({ title: data?.message ?? 'That change was refused.', color: 'error' })
  }
}
</script>

<template>
  <div class="space-y-8">
    <div>
      <h1 class="text-2xl font-bold tracking-tight">Accounts</h1>
      <p class="text-sm text-white/65">There is no sign-up. People get in by invite.</p>
    </div>

    <UCard>
      <template #header>
        <div class="flex items-center gap-3">
          <h2 class="font-semibold">Invites</h2>
          <UButton class="ml-auto" size="sm" icon="i-lucide-plus" @click="mint">Mint a token</UButton>
        </div>
      </template>

      <UAlert
        v-if="freshToken"
        color="primary"
        variant="subtle"
        icon="i-lucide-key-round"
        class="mb-4"
        title="Copy this now — it is not shown again"
      >
        <template #description>
          <div class="mt-2 flex items-center gap-2">
            <code class="grow rounded bg-black/40 px-2 py-1 font-mono text-xs break-all">
              {{ freshToken }}
            </code>
            <UButton size="xs" icon="i-lucide-copy" @click="copy">Copy</UButton>
          </div>
        </template>
      </UAlert>

      <ul class="divide-y divide-white/10 text-sm">
        <li v-for="invite in invites?.items ?? []" :key="invite.id" class="flex items-center gap-3 py-2">
          <UBadge color="neutral" variant="subtle" size="sm">{{ invite.kind }}</UBadge>
          <span class="text-white/65">
            {{ new Date(invite.createdAt).toLocaleDateString() }}
          </span>
          <UBadge
            :color="invite.redeemedAt ? 'success' : 'neutral'"
            variant="subtle"
            size="sm"
            class="ml-auto"
          >
            {{ invite.redeemedAt ? 'redeemed' : 'unused' }}
          </UBadge>
        </li>
      </ul>
      <p v-if="!invites?.items?.length" class="text-sm text-white/70">No invites yet.</p>
    </UCard>

    <UCard>
      <template #header><h2 class="font-semibold">People</h2></template>
      <table class="w-full text-sm">
        <tbody class="divide-y divide-white/10">
          <tr v-for="account in users?.items ?? []" :key="account.id">
            <td class="py-3">
              <p class="font-medium">
                {{ account.displayName }}
                <span v-if="account.id === user?.id" class="text-xs text-white/70">(you)</span>
              </p>
              <p class="text-xs text-white/70">{{ account.username }}</p>
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
                  variant="subtle"
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
    </UCard>
  </div>
</template>
