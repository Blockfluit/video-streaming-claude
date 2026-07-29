<script setup lang="ts">
// Scaffolding placeholder — replaced by the Netflix-style home page in step 17.
// Its one job right now is to prove the /api proxy reaches NestJS on :4000,
// both during SSR (from Nitro) and on the client.
const { data, error } = await useFetch('/api/health')
</script>

<template>
  <UContainer class="py-16">
    <h1 class="text-2xl font-semibold">video-streaming-claude</h1>
    <p class="mt-2 text-(--ui-text-muted)">Scaffolding is up. Nothing is implemented yet.</p>

    <UCard class="mt-8">
      <template #header>
        <div class="flex items-center gap-2">
          <span class="font-medium">API health</span>
          <UBadge :color="error ? 'error' : 'success'" variant="subtle">
            {{ error ? 'unreachable' : 'ok' }}
          </UBadge>
        </div>
      </template>

      <pre class="text-sm">{{ error ? error.message : data }}</pre>
    </UCard>
  </UContainer>
</template>
