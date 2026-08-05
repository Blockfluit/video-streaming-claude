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
  <!--
    `scroll-body="false"` forwards to Reka's `ConfigProvider`.

    When an overlay locks the body, Reka hides the scrollbar and adds a matching
    `padding-right` to stand in for the width it just took away. `main.css`
    already reserves that gutter permanently with `scrollbar-gutter: stable`, so
    nothing is taken away and the padding is pure damage: it moves the centred
    `.page-shell` while the `position: fixed` header — laid out against the
    viewport, not the body's content box — stays where it is, and the two halves
    of the page slide apart.

    False keeps the lock (a modal should still stop the page scrolling behind it)
    and drops only the compensation.
  -->
  <UApp :scroll-body="false">
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
