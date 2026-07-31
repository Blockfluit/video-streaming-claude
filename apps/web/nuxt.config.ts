// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2026-07-29',
  devtools: { enabled: true },

  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],

  // Nuxt Icon serves its runtime bundle from `/api/_nuxt_icon` by default,
  // which the proxy below swallows whole and forwards to NestJS — where it is
  // a 404, and any icon resolved at runtime silently fails to draw. Moved off
  // `/api` so the two do not fight over the prefix.
  icon: { localApiEndpoint: '/_icons' },

  devServer: { port: 3000 },

  routeRules: {
    // Everything the browser touches is same-origin on :3000. This is not just
    // convenience: a cross-origin <track> fails silently, and <video>/<track>
    // cannot send Authorization headers — which is why auth is cookie-based.
    '/api/**': { proxy: 'http://localhost:4000/**' },
  },
})
