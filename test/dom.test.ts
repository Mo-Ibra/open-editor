/**
 * Guards the dumbest class of bug in a page split across .html and .ts:
 * referencing an element id that does not exist. The failure surfaces as a
 * null dereference in an unrelated function, minutes later.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../phase0.html', import.meta.url), 'utf8')
const ts = readFileSync(new URL('../src/phase0.ts', import.meta.url), 'utf8')

const declared = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!))
// Everything looked up via $('...')
const looked = new Set([...ts.matchAll(/\$\w*<[^>]*>\('([^']+)'\)/g)].map((m) => m[1]!))

assert.ok(declared.size > 5, 'expected the page to declare some ids')
assert.ok(looked.size > 5, 'expected the script to look some ids up')

const missing = [...looked].filter((id) => !declared.has(id))
assert.deepEqual(missing, [], `phase0.ts looks up ids not in phase0.html: ${missing.join(', ')}`)

const unused = [...declared].filter((id) => !looked.has(id) && !['drop', 'preview'].includes(id))
console.log(`  ${declared.size} ids declared, ${looked.size} looked up, all present`)
if (unused.length) console.log(`  (declared but unused: ${unused.join(', ')})`)

console.log('dom id assertions passed')

/**
 * A list rendered from a non-reactive source never updates.
 *
 * This shipped once: the asset bin iterated MediaLibrary's internal Map, which
 * is a plain Map and not a Solid store. Files imported fine, the notice fired,
 * and the bin stayed empty — a success path that renders nothing. The failure
 * is invisible to a type checker and to any test that does not run a browser,
 * so it gets a source-level guard instead.
 */
{
  const { readdirSync, statSync } = await import('node:fs')
  const { join } = await import('node:path')
  const srcDir = new URL('../src/', import.meta.url).pathname

  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name)
      return statSync(full).isDirectory() ? walk(full) : full.endsWith('.tsx') ? [full] : []
    })

  // Strip comments first: the codebase documents this exact bug in a comment,
  // and a scanner that reads its own documentation reports a false positive.
  const stripComments = (code: string): string =>
    code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  const offenders: string[] = []
  for (const file of walk(srcDir)) {
    const code = stripComments(readFileSync(file, 'utf8'))
    // MediaLibrary.all() enumerates a plain Map. Only state.ts may call it,
    // and only to expose the non-reactive heavy entry, never as a list source.
    if (code.includes('.library.all()') || code.includes('library.all()')) {
      offenders.push(file.replace(srcDir, 'src/'))
    }
  }
  assert.deepEqual(offenders, [], `components must not render lists from library.all(): ${offenders.join(', ')}`)

  // And the bin must derive its list from the store.
  const bin = readFileSync(new URL('../src/ui/AssetBin.tsx', import.meta.url), 'utf8')
  assert.ok(bin.includes('state.assetIds()'), 'AssetBin should iterate reactive asset ids')
}

console.log('wiring assertions passed')

/**
 * No `!` definite-assignment assertions on browser objects.
 *
 * `let ctx!: CanvasRenderingContext2D` compiles perfectly while `ctx` is
 * permanently `undefined`. The compiler stops checking, the error surfaces at
 * runtime as `Cannot read properties of undefined (reading 'save')` from a
 * different module, and it cost four rounds of debugging to trace back.
 *
 * A `!` on a value that must be produced by an operation is a lie to the
 * type system. Assert on the *result* of the operation instead.
 *
 * Scoped deliberately: a `!` on a `HTMLCanvasElement` bound via Solid's `ref`
 * is correct and is not flagged. Only a context, which nobody assigns for you.
 */
{
  const { readdirSync, statSync } = await import('node:fs')
  const { join } = await import('node:path')
  const srcDir = new URL('../src/', import.meta.url).pathname

  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name)
      return statSync(full).isDirectory() ? walk(full) : full.endsWith('.ts') || full.endsWith('.tsx') ? [full] : []
    })

  // Strip comments first: the codebase documents this exact bug in a comment,
  // and a scanner that reads its own documentation reports a false positive.
  const stripComments = (code: string): string =>
    code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  const offenders: string[] = []
  for (const file of walk(srcDir)) {
    const code = stripComments(readFileSync(file, 'utf8'))
    // Only values that are NOT assigned by a JSX `ref`. `let canvas!:
    // HTMLCanvasElement` is legitimate — Solid assigns it — but a 2D context
    // has to be acquired by calling getContext(), and a `!` there means
    // nothing ever will.
    if (/let\s+\w+!\s*:\s*(CanvasRenderingContext2D|OffscreenCanvas\b)/.test(code)) {
      offenders.push(file.replace(srcDir, 'src/'))
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these declare a DOM object with "!" and so may never be assigned: ${offenders.join(', ')}`,
  )
}

console.log('no-definite-assertion assertions passed')

/**
 * Every `let x!: DOMType` must actually be bound to a `ref={x}`.
 *
 * A dropped `ref` is the worst kind of bug: the `!` makes it compile, the
 * variable stays `undefined`, and the first event that touches it throws
 * somewhere unrelated. This shipped once — the timeline lost its `ref` during a
 * rewrite, and clicking anywhere stopped working while split and delete kept
 * working, so it read as "the playhead is broken" rather than "an exception is
 * being thrown on every pointerdown".
 */
{
  const { readdirSync, statSync } = await import('node:fs')
  const { join } = await import('node:path')
  const srcDir = new URL('../src/', import.meta.url).pathname

  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name)
      return statSync(full).isDirectory() ? walk(full) : full.endsWith('.tsx') ? [full] : []
    })

  const DOM_TYPE = /(HTML\w+Element|OffscreenCanvas|CanvasRenderingContext2D|SVG\w+Element)/
  const problems: string[] = []

  for (const file of walk(srcDir)) {
    const raw = readFileSync(file, 'utf8')
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    const relative = file.replace(srcDir, 'src/')

    for (const match of code.matchAll(/\blet\s+(\w+)!\s*:\s*([\w.]+)/g)) {
      const [, name, type] = match
      if (!DOM_TYPE.test(type ?? '')) continue
      // Bound by a ref, or it is a lie to the compiler and a runtime throw.
      const bound = new RegExp(`ref=\\{${name}\\}`).test(code) || new RegExp(`ref=\\{${name} as`).test(code)
      if (!bound) problems.push(`${relative}: \`let ${name}!: ${type}\` has no ref={${name}}`)
    }
  }

  assert.deepEqual(problems, [], `unbound definite-assignment assertions:\n  ${problems.join('\n  ')}`)
}

console.log('ref-binding assertions passed')
