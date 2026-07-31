import { defineConfig } from 'vitest/config'

/**
 * Only the pure parts are tested here — path sanitising, formatting, the small
 * decisions that are easy to get subtly wrong and cheap to pin down. Rendering
 * is not: a component test that mounts Nuxt's auto-imports and its router costs
 * far more to keep working than it catches, and the API's own suites already
 * cover everything behind the fetch.
 */
export default defineConfig({
  test: {
    include: ['app/**/*.spec.ts'],
    environment: 'node',
  },
})
