import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

/**
 * No local binding may take the name of a Vue API that Nuxt auto-imports.
 *
 * This is not a style rule. A parameter named `ref` in `admin/lists.vue` made
 * the **production** build emit that page's chunk with no `import { ref }` in
 * it, so `const newTitle = ref('')` called a free global and setup threw
 * `ReferenceError: ref is not defined`. A component whose setup throws renders
 * nothing, so the page was a blank content area inside an intact admin layout —
 * no heading, no error, nothing to click. It reached the acceptance environment
 * because nothing here catches it:
 *
 *  - `npm run dev` does not reproduce it. Only the production build does.
 *  - The Playwright suite runs against the **dev servers**, so its `pageerror`
 *    watchdog — which is exactly the right assertion — never sees this.
 *
 * That leaves the source itself as the only cheap place to check, which is what
 * this does. Verified by mutation: renaming `entry` back to `ref` in
 * `admin/lists.vue` fails this test, and rebuilding reproduces the blank page.
 *
 * Parsed rather than grepped, because the two cases genuinely differ and a regex
 * cannot tell them apart: `{ watch: [q, tag] }` in `browse.vue` is an option key
 * and completely fine, while `(row, ref: T)` is a binding and is not.
 */

/** The auto-imports a page is most likely to shadow by accident. */
const RESERVED = new Set([
  'ref',
  'computed',
  'reactive',
  'shallowRef',
  'toRef',
  'toRefs',
  'watch',
  'watchEffect',
  'readonly',
  'nextTick',
  'provide',
  'inject',
])

const APP_DIR = join(import.meta.dirname, '..')

function vueFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
    const path = join(dir, item.name)
    if (item.isDirectory()) return item.name === 'node_modules' ? [] : vueFiles(path)
    return item.name.endsWith('.vue') ? [path] : []
  })
}

/**
 * Every name this script block *binds*, at any depth.
 *
 * Only declaration positions count. A type-level tuple label (`add: [ref: T]`)
 * is erased before it can shadow anything, and an object property key never
 * shadowed anything in the first place — neither is a binding, and neither
 * appears here.
 */
function boundNames(code: string): Map<string, number> {
  const source = ts.createSourceFile('script.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const found = new Map<string, number>()

  const record = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) {
      const line = source.getLineAndCharacterOfPosition(name.getStart(source)).line + 1
      if (!found.has(name.text)) found.set(name.text, line)
      return
    }
    // Destructuring: `const { ref } = …`, `([ref]) => …`
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) record(element.name)
    }
  }

  const walk = (node: ts.Node): void => {
    if (ts.isParameter(node) || ts.isVariableDeclaration(node) || ts.isBindingElement(node)) {
      record(node.name)
    }
    else if (
      (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node))
      && node.name !== undefined
    ) {
      record(node.name)
    }
    ts.forEachChild(node, walk)
  }

  walk(source)
  return found
}

describe('Vue auto-imports are never shadowed', () => {
  const files = vueFiles(APP_DIR)

  it('finds the components to check', () => {
    // A sweep that silently matched nothing would pass forever.
    expect(files.length).toBeGreaterThan(20)
  })

  it.each(files.map(file => [file.slice(APP_DIR.length + 1), file]))('%s', (_label, file) => {
    const { descriptor } = parse(readFileSync(file, 'utf8'))
    const code = descriptor.scriptSetup?.content ?? descriptor.script?.content
    if (code === undefined) return

    const clashes = [...boundNames(code)]
      .filter(([name]) => RESERVED.has(name))
      .map(([name, line]) => `${name} (line ${line} of the script block)`)

    expect(clashes, `shadows an auto-imported Vue API: ${clashes.join(', ')}`).toEqual([])
  })
})
