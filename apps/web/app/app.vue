<script setup lang="ts">
/**
 * The title suffix.
 *
 * A function rather than a `'%s · Library'` string, because the string form
 * renders a bare " · Library" on any route that sets no title of its own —
 * which includes every error page. It lives here instead of `nuxt.config`
 * because `app.head.titleTemplate` has to be serialisable and a function is not.
 */
useHead({
  titleTemplate: title => (title ? `${title} · Library` : 'Library'),
})
</script>

<template>
  <UApp>
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
