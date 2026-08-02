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

  devServer: { port: Number(process.env.NUXT_DEV_PORT ?? 3000) },

  routeRules: {
    // Everything the browser touches is same-origin on :3000. This is not just
    // convenience: a cross-origin <track> fails silently, and <video>/<track>
    // cannot send Authorization headers — which is why auth is cookie-based.
    //
    // NUXT_API_TARGET is read while `nuxt build` runs and baked into the Nitro
    // output; setting it on a running container does nothing. That is why the
    // API service is named `api` in every deployment — see deploy/README.md.
    //
    // `streamRequest` asks h3 not to buffer the request body. Measured: it
    // does not currently help on the node-server preset. getRequestWebStream
    // falls back to readRawBody when the incoming request looks like it has a
    // raw body, which reads the whole thing into memory anyway — a 600 MB
    // upload grew this process by ~575 MB, and a 256 MB container was
    // OOM-killed by it. It is set because it is the correct declaration and
    // costs nothing if h3 fixes that path.
    //
    // Production does not depend on it: Traefik routes `/api` on the web
    // hostname straight to the API, so browser uploads never pass through here
    // at all (see deploy/compose.yml). What still comes through this rule is
    // SSR — small JSON reads, in-process — and `npm run dev`, where a large
    // upload does buffer.
    '/api/**': {
      proxy: {
        to: `${process.env.NUXT_API_TARGET ?? 'http://localhost:4000'}/**`,
        streamRequest: true,
      },
    },
  },
})
