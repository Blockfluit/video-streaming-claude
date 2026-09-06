import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * A component that calls `defineExpose` must not also have a top-level
 * `await` in its own `<script setup>`.
 *
 * A top-level `await` makes `setup()` return a Promise, and Vue only points a
 * parent's template `ref` at the component's `exposeProxy` (the object
 * `defineExpose` built) when `instance.exposed` is already populated at the
 * moment the ref is bound. For an async-setup component under Suspense, that
 * population can lose the race against the ref binding — and once lost, the
 * ref is left pointing at the plain internal instance proxy forever, which
 * has none of the exposed methods. `VideoJobs.vue` hit this: its `Publish`
 * button called `jobs.value?.refresh()`, `jobs.value` was a non-null proxy
 * with no `refresh`, and the resulting `TypeError` was swallowed by the
 * page's own catch block — so a publish that had already succeeded on the
 * server showed "That did not work" anyway.
 *
 *  - `npm run dev` does not reproduce it — confirmed only in a local
 *    production build (`nuxt build` + `node .output/server/index.mjs`)
 *    driven by a real browser.
 *  - The Playwright suite runs against the **dev servers**, so it never
 *    exercises the timing that causes this.
 *
 * That leaves the source itself as the cheap place to catch it — the same
 * reasoning `auto-imports.spec.ts` documents for its own build-only defect.
 * The fix is almost always to drop the `await`: `useApiData`'s `data` and
 * `refresh` are live refs the moment the call returns, whether or not the
 * caller awaits it (SSR data-fetching still happens via `onServerPrefetch`,
 * registered inside `useApiData` regardless), so most components gain
 * nothing from awaiting it in the first place.
 */

/**
 * Components whose `await` is load-bearing for a reason *other than* data
 * availability, so it cannot simply be dropped — recorded here with why, and
 * with what limits the blast radius until it can be restructured.
 *
 * `VideoPlayer.vue`: the `await` guarantees the `<video>` element exists
 * before `onLoadedMetadata`'s resume logic runs (see the comment on
 * `onLoadedMetadata` in that file) — removing it changes *playback*
 * correctness, not just this hazard. Its one exposed method is already
 * called defensively (`player?.seek?.(seconds)` in `watch/[slug].vue`), so
 * the failure mode there is a silent no-op rather than a crash — lower
 * severity than `VideoJobs.vue`, and a known follow-up rather than a
 * surprise.
 */
const EXEMPT = new Set(['components/VideoPlayer.vue'])

const APP_DIR = join(import.meta.dirname, '..')

function vueFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
    const path = join(dir, item.name)
    if (item.isDirectory()) return item.name === 'node_modules' ? [] : vueFiles(path)
    return item.name.endsWith('.vue') ? [path] : []
  })
}

function callsDefineExpose(source: ts.SourceFile): boolean {
  let found = false
  const walk = (node: ts.Node): void => {
    if (found) return
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'defineExpose'
    ) {
      found = true
      return
    }
    ts.forEachChild(node, walk)
  }
  walk(source)
  return found
}

/** An `await` that is part of `setup()` itself, not inside a nested function. */
function hasTopLevelAwait(source: ts.SourceFile): boolean {
  let found = false
  const isFunctionBoundary = (node: ts.Node): boolean =>
    ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isGetAccessor(node)
    || ts.isSetAccessor(node)

  const walk = (node: ts.Node): void => {
    if (found) return
    if (ts.isAwaitExpression(node)) {
      found = true
      return
    }
    if (isFunctionBoundary(node)) return
    ts.forEachChild(node, walk)
  }
  walk(source)
  return found
}

describe('a component with defineExpose has a synchronous setup', () => {
  const files = vueFiles(APP_DIR)

  it('finds the components to check', () => {
    // A sweep that silently matched nothing would pass forever.
    expect(files.length).toBeGreaterThan(20)
  })

  it.each(files.map(file => [file.slice(APP_DIR.length + 1), file]))('%s', (label, file) => {
    const { descriptor } = parse(readFileSync(file, 'utf8'))
    const code = descriptor.scriptSetup?.content
    if (code === undefined) return

    const source = ts.createSourceFile('script.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const unsafe = callsDefineExpose(source) && hasTopLevelAwait(source) && !EXEMPT.has(label)

    expect(
      unsafe,
      `${label} calls defineExpose but has a top-level await, which races Vue's `
      + `template-ref-to-exposeProxy binding in production — see this file's header comment`,
    ).toBe(false)
  })
})
