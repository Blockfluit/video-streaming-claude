// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2026-07-29',
  devtools: { enabled: true },

  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],

  // The suffix itself lives in app.vue: `titleTemplate` has to be a serialisable
  // string here, and a string template renders " · Library" for any route that
  // sets no title of its own.
  app: { head: { htmlAttrs: { lang: 'en' } } },

  // Nuxt Icon serves its runtime bundle from `/api/_nuxt_icon` by default,
  // which the proxy below swallows whole and forwards to NestJS — where it is
  // a 404, and any icon resolved at runtime silently fails to draw. Moved off
  // `/api` so the two do not fight over the prefix.
  icon: { localApiEndpoint: '/_icons' },

  // A video library is watched in the dark. There is no light theme to fall
  // back to, so the class is fixed rather than left to a system preference
  // that would otherwise flash white on first paint.
  colorMode: { preference: 'dark', fallback: 'dark' },

  // Nuxt's own NUXT_PORT overrides this, which is how a second worktree gets
  // out of the way without a config change.
  devServer: { port: 3000 },

  routeRules: {
    /*
     * Everything the browser touches is same-origin on the dev port. This is
     * not just convenience: a cross-origin <track> fails silently, and
     * <video>/<track> cannot send Authorization headers — which is why auth is
     * cookie-based.
     *
     * The target is overridable because several worktrees are developed at
     * once here. Two stacks both assuming :4000 means the second silently
     * proxies to the first one's API, and the page then renders perfectly
     * while showing another branch's data — which is far worse than a port
     * conflict that fails loudly.
     */
    '/api/**': { proxy: `${process.env['NUXT_API_TARGET'] ?? 'http://localhost:4000'}/**` },
  },
})
