// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2026-07-29',
  devtools: { enabled: true },

  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],

  devServer: { port: 3000 },

  routeRules: {
    // Everything the browser touches is same-origin on :3000. This is not just
    // convenience: a cross-origin <track> fails silently, and <video>/<track>
    // cannot send Authorization headers — which is why auth is cookie-based.
    '/api/**': { proxy: 'http://localhost:4000/**' },
  },
})
