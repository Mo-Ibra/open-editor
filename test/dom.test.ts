/**
 * Guards the dumbest class of bug in a page split across .html and .ts:
 * referencing an element id that does not exist. The failure surfaces as a
 * null dereference in an unrelated function, minutes later.
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

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
  const srcDir = new URL('../src', import.meta.url).pathname

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
  const bin = readFileSync(new URL('../src/app/view/AssetBin.tsx', import.meta.url), 'utf8')
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
  const srcDir = new URL('../src', import.meta.url).pathname

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
  const srcDir = new URL('../src', import.meta.url).pathname

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

/**
 * A panel rendered twice.
 *
 * This shipped once: the layout rewrite added a resizable timeline inside the
 * main grid but left the original fixed-position one in place below it. Two
 * timelines, both live, both wired to the same state.
 *
 * It type-checked cleanly and no unit test could see it, because a second
 * `<Timeline state={state} menu={menu} />` is a perfectly valid element — the
 * props match. Only the count is wrong. So the count is the assertion.
 */
{
  const app = readFileSync(new URL('../src/app/view/App.tsx', import.meta.url), 'utf8')
  // Only JSX usage: the import line and any local variable named e.g. `Timeline`
  // are not element instantiations.
  const singletons = ['AssetBin', 'Preview', 'Timeline', 'ExportDialog', 'ContextMenu']

  const problems: string[] = []
  for (const name of singletons) {
    const uses = [...app.matchAll(new RegExp(`<${name}[\\s/>]`, 'g'))].length
    if (uses !== 1) {
      problems.push(`${name} is rendered ${uses} times, expected exactly 1`)
    }
  }
  assert.deepEqual(problems, [], `duplicate or missing panels:\n  ${problems.join('\n  ')}`)
  console.log(`  ${singletons.length} singleton panels rendered exactly once each`)
}

/**
 * The context menu must open on a right click and only a right click.
 *
 * It once hung off `onPointerDown`, so every left click on a clip popped the
 * menu open — which made clicking a clip to select it impossible. Nothing about
 * that is visible to the type checker, and no unit test renders the timeline.
 *
 * The check is structural: a menu must not be opened from a pointerdown.
 */
{
  const files = ['../src/app/view/timeline/use-timeline-drag.ts', '../src/app/view/AssetBin.tsx', '../src/app/view/Preview.tsx']
  const problems: string[] = []
  for (const rel of files) {
    const code = readFileSync(new URL(rel, import.meta.url), 'utf8')
    // Find each onPointerDown body and look for a menu being opened inside it.
    const bodies = code.match(/onPointerDown=\{[^}]*\}[^>]*>|function onPointerDown[\s\S]*?\n  \}/g) ?? []
    for (const body of bodies) {
      if (/\bmenu\.(show|toggle)\(/.test(body)) {
        problems.push(`${rel}: a context menu is opened from a pointer-down handler`)
      }
    }
    // A file that opens a menu must either bind the handler or define it.
    // Which one it is depends on the split: AssetBin and Preview do both in
    // place, while the timeline defines its handler in the drag controller and
    // binds it in the component. The wiring between them is asserted below.
    if (/menu\.(show|toggle)\(/.test(code) && !/onContextMenu=/.test(code) && !/function onContextMenu/.test(code)) {
      problems.push(`${rel}: opens a context menu but neither binds nor defines onContextMenu`)
    }
  }

  // The timeline's handler is defined in the drag controller and bound in the
  // component, so neither file alone proves the right-click works. The binding
  // has to name the controller, or the split has silently disconnected it.
  {
    const controller = readFileSync(
      new URL('../src/app/view/timeline/use-timeline-drag.ts', import.meta.url), 'utf8')
    const timeline = readFileSync(new URL('../src/app/view/Timeline.tsx', import.meta.url), 'utf8')
    assert.match(
      controller, /function onContextMenu/,
      'the drag controller should define the timeline\'s right-click handler')
    assert.match(
      timeline, /onContextMenu=\{drag\.onContextMenu\}/,
      'and the timeline should bind that exact handler — otherwise right-click on a clip does nothing')
  }
  assert.deepEqual(problems, [], `context menu wiring:\n  ${problems.join('\n  ')}`)
  console.log(`  context menus open on right click only (${files.length} components)`)
}

/**
 * An arbitrary Tailwind value must produce a *valid* declaration.
 *
 * A selection ring written as `shadow-[0_0_0_1px_#ffffff/45]` compiles to:
 *
 *   --tw-shadow: 0 0 0 1px var(--tw-shadow-color,#fff)/45
 *
 * The opacity modifier lands on the `var()`, not the colour, so the browser
 * discards the whole `box-shadow`. The class exists in the stylesheet, so no
 * build or type error fires — the ring is simply never drawn, and a
 * multi-selection looks like a single selected clip.
 *
 * This checks the generated CSS rather than the source, because the source
 * looks fine. Opacity is not allowed inside an arbitrary shadow/gradient value.
 */
{
  const distDir = new URL('../dist/assets', import.meta.url).pathname
  const css = existsSync(distDir)
    ? readdirSync(distDir)
        .filter((f) => f.endsWith('.css'))
        .map((f) => readFileSync(join(distDir, f), 'utf8'))
        .join('\n')
    : ''

  if (!css) {
    console.log('  (no built CSS found — run `vite build` to check arbitrary values)')
  } else {
    // `var(--tw-…)/NN` is never valid: an opacity modifier cannot apply to a
    // custom property reference. The optional fallback inside the var() has to
    // be allowed for, or the pattern silently matches nothing and this guard
    // passes on the exact CSS it exists to reject.
    const broken = [...css.matchAll(/var\(--[a-z-]+(?:,[^)]*)?\)\s*\/\s*\d+/g)].map((m) => m[0])
    assert.deepEqual(
      broken,
      [],
      `opacity modifier applied to a var(), which is invalid CSS:\n  ${[...new Set(broken)].join('\n  ')}`,
    )
    console.log(`  no invalid opacity-on-var() declarations in ${css.length} bytes of CSS`)
  }
}

/**
 * Documentation references in the source must resolve.
 *
 * Code comments point at docs by path — `docs/data-model.md`,
 * `docs/decisions/0004-…#drm-audio`. Thirty of them did. When `PLAN.md` was
 * split into `docs/`, every one of those pointers had to be rewritten, and a
 * missed rewrite is invisible: the comment still reads fine, the file it names
 * just does not exist, and the reader loses the reasoning at exactly the moment
 * they wanted it.
 *
 * Also checks the anchor, because `#av-sync` silently becoming wrong is the same
 * failure as the file being gone.
 */
{
  const repoRoot = new URL('..', import.meta.url).pathname
  const sources: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.tsx?$/.test(entry.name)) sources.push(full)
    }
  }
  walk(join(repoRoot, 'src'))
  walk(join(repoRoot, 'test'))

  const problems: string[] = []
  let checked = 0

  for (const file of sources) {
    const code = readFileSync(file, 'utf8')
    for (const match of code.matchAll(/(docs\/[a-z0-9./-]+\.md)(#[a-z0-9-]+)?/gi)) {
      checked += 1
      const path = match[1]!
      const anchor = match[2]
      const target = join(repoRoot, path)
      if (!existsSync(target)) {
        problems.push(`${file.replace(repoRoot, '')}: ${path} does not exist`)
        continue
      }
      if (anchor) {
        const heading = anchor.slice(1)
        const body = readFileSync(target, 'utf8').toLowerCase()
        // GitHub anchors, replicated exactly: lowercase, drop punctuation
        // other than space and hyphen, trim, then EVERY space becomes one
        // hyphen. Collapsing runs of whitespace looks tidier and is wrong —
        // "R2 — Encode speed" slugs to "r2--encode-speed" with two hyphens,
        // because the em-dash is deleted and leaves the two spaces either side
        // of it intact.
        const slugs = [...body.matchAll(/^#{1,6}\s+(.+)$/gm)].map((h) =>
          h[1]!
            .toLowerCase()
            .replace(/[^\w\s-]/g, '')
            .trim()
            .replace(/ /g, '-'),
        )
        if (!slugs.includes(heading)) {
          problems.push(`${file.replace(repoRoot, '')}: ${path} has no heading '${heading}'`)
        }
      }
    }
  }

  assert.deepEqual(problems, [], `broken doc references:\n  ${problems.join('\n  ')}`)
  assert.ok(checked >= 25, `expected the source to reference docs often, found ${checked}`)
  console.log(`  ${checked} doc references across ${sources.length} files, all resolve`)
}

/**
 * The legend's mouse gestures must describe what the timeline actually does.
 *
 * `^click` and `⇧click` appear in the status bar as shortcuts, but no keypress
 * produces them — they are handled in the timeline's pointerdown. Nothing
 * connects the two, so renaming a select mode, or dropping the ctrl branch,
 * would leave the footer confidently describing a gesture the app no longer
 * has.
 *
 * Checked from the source, because the alternative is a browser.
 */
{
  const timeline = readFileSync(new URL('../src/app/view/timeline/use-timeline-drag.ts', import.meta.url), 'utf8')

  assert.match(
    timeline,
    /state\.selectClip\(clip\.id, selectModeOf\(event\)\)/,
    'a clip click must go through selectModeOf, or the modifier rules below are dead code',
  )

  // Order matters: shift wins, then ctrl/cmd, else replace. Pinned because a
  // rewrite that checks ctrl first silently changes ctrl+shift behaviour.
  const mode = timeline.match(/function selectModeOf[\s\S]*?\n}/)?.[0] ?? ''
  assert.ok(mode, 'selectModeOf should exist')
  const shiftAt = mode.indexOf('shiftKey')
  const ctrlAt = mode.indexOf('ctrlKey')
  const metaAt = mode.indexOf('metaKey')
  assert.ok(shiftAt >= 0 && ctrlAt >= 0 && metaAt >= 0, 'all three modifiers must be honoured')
  assert.ok(shiftAt < ctrlAt, 'shift must be tested first — it is the more specific intent')
  assert.ok(mode.includes("'range'") && mode.includes("'toggle'") && mode.includes("'replace'"),
    'range, toggle and replace must all be reachable')

  // And the legend must still name both gestures.
  const shortcuts = readFileSync(new URL('../src/app/commands/shortcuts.ts', import.meta.url), 'utf8')
  for (const gesture of ['^click', '⇧click']) {
    assert.ok(shortcuts.includes(gesture), `the legend should still advertise ${gesture}`)
  }
  console.log('  legend gestures match the timeline\'s select modes')
}

/**
 * Ctrl+wheel must be handled natively, and non-passively.
 *
 * Two failure modes, neither visible to a type checker:
 *
 *  1. A passive listener cannot call `preventDefault`, so ctrl+wheel zooms the
 *     timeline *and* the whole browser page.
 *  2. Binding it through JSX `onWheel` makes that passive-ness the default on
 *     some engines, and gives no way to be explicit.
 *
 * Also pinned: a plain wheel must still be left alone, because panning is a
 * gesture people already have.
 */
{
  const timeline = readFileSync(new URL('../src/app/view/timeline/use-timeline-drag.ts', import.meta.url), 'utf8')

  assert.match(
    timeline,
    /addEventListener\('wheel', onWheel, \{ passive: false \}\)/,
    'the wheel listener must be registered natively and non-passively',
  )
  assert.match(
    timeline,
    /removeEventListener\('wheel', onWheel\)/,
    'and removed again — a leaked listener outlives the component',
  )
  assert.ok(
    !/onWheel=\{/.test(timeline),
    'there should be no JSX onWheel binding; the native one is the whole point',
  )

  const handler = timeline.match(/function onWheel[\s\S]*?\n  \}/)?.[0] ?? ''
  assert.ok(handler, 'onWheel should exist')
  assert.match(
    handler,
    /if \(!event\.ctrlKey && !event\.metaKey\) return/,
    'a plain wheel must be left alone so it still scrolls',
  )
  assert.match(handler, /event\.preventDefault\(\)/, 'and ctrl+wheel must stop the browser zooming the page')

  // Coalescing. A wheel fires far faster than a frame; applying per event meant
  // dozens of forced layouts per second, because each one read the scroll
  // geometry after the previous event had already dirtied it.
  assert.match(handler, /pendingNotches \+=/, 'the delta must be accumulated, not applied per event')
  assert.match(
    handler,
    /requestAnimationFrame\(applyPendingZoom\)/,
    'and applied at most once per animation frame',
  )
  // The anchor needs the pointer position, which only exists on the event, so it
  // must be captured there and used in the frame callback.
  assert.match(handler, /wheelClientX = event\.clientX/, 'the pointer position must be recorded from the event')

  const apply = timeline.match(/function applyPendingZoom[\s\S]*?\n  \}/)?.[0] ?? ''
  assert.ok(apply, 'applyPendingZoom should exist')
  assert.match(apply, /scrollLeftAfterZoom\(/, 'and it must zoom about the pointer, not the origin')
  assert.match(apply, /pendingNotches = 0/, 'and reset the accumulator, or it grows forever')
  assert.match(
    apply,
    /getBoundingClientRect\(\)/,
    'the scroll geometry is read once per frame, before any write',
  )

  // The legend advertises it, so the feature is discoverable.
  const shortcuts = readFileSync(new URL('../src/app/commands/shortcuts.ts', import.meta.url), 'utf8')
  assert.ok(shortcuts.includes('^scroll'), 'the legend should advertise ctrl+scroll')
  console.log('  ctrl+wheel zoom is wired natively, non-passively, and advertised')
}

/**
 * The timeline's gesture contract: what the drag controller *reads* must still
 * be *written* somewhere.
 *
 * The split moved the producer of these attributes — `Clip.tsx` and `Lane.tsx` —
 * into different files from the consumer, `use-timeline-drag.ts`. Nothing in the
 * type system connects them: `closest('[data-lane]')` and `dataset.handle` are
 * strings, so renaming one side breaks dragging at runtime with no compile
 * error, no unit test, and nothing visible until a user grabs a trim handle.
 *
 * So the two halves are checked against each other, from the source.
 */
{
  const read = readFileSync(
    new URL('../src/app/view/timeline/use-timeline-drag.ts', import.meta.url), 'utf8')
  const read2 = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')
  const written = [
    read2('../src/app/view/timeline/Clip.tsx'),
    read2('../src/app/view/timeline/Lane.tsx'),
    read2('../src/app/view/Timeline.tsx'),
  ].join('\n')

  // Every attribute the controller looks up, as it appears in the query.
  const queries = [
    ...read.matchAll(/closest\('\[([a-z-]+)\]'\)/g),
    ...read.matchAll(/dataset\.([a-zA-Z]+)/g),
  ]
  const names = new Set(queries.map((m) => m[1]!).filter(Boolean))
  assert.ok(names.size >= 3, `expected the controller to look up several attributes, found ${[...names]}`)

  const missing: string[] = []
  for (const name of names) {
    // Read as `data-x` from closest(), `x` from dataset.x.
    const attr = name.startsWith('data-') ? name : `data-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`
    if (!written.includes(attr)) missing.push(attr)
  }
  assert.deepEqual(missing, [], `the drag controller reads attributes nothing renders: ${missing.join(', ')}`)

  // The lane a clip lives in comes from the DOM, not from a prop, so a clip
  // rendered outside a lane would resolve to `undefined` and do nothing.
  assert.match(written, /data-lane=\{props\.lane\}|data-lane="|data-lane=\{/, 'a lane must render data-lane')
  assert.match(written, /data-clip-id=\{props\.clip\.id\}/, 'a clip must render its own id')
  assert.match(written, /data-clip-index=\{props\.index\}/, 'and its index, which drag reads as a number')
  console.log(`  ${names.size} gesture attributes are both read and rendered`)
}

/**
 * `file:line` references in the docs must still point at what they claim.
 *
 * The walkthroughs in `docs/traces/` are the study material for the whole
 * codebase, and every one of them cites specific lines — `splitLinked` at
 * `project.ts:446`, the "cache first" rule at `Preview.tsx:197`. A line-number
 * reference is the most rot-prone thing a document can contain: the code moves,
 * the sentence still reads perfectly, and the reader is now confidently sent to
 * the wrong line.
 *
 * The check is deliberately weak — file exists, line is in range, line is not
 * blank. It will not catch a citation that is *in range* but has drifted onto a
 * neighbouring statement. It will catch a rename, a move, and a deleted file,
 * which is where most of the rot comes from, and it costs one `readFileSync`.
 *
 * A blank line is treated as failure on purpose: a doc pointing at an empty line
 * is a doc pointing at the place a function used to be.
 */
{
  const repoRoot = new URL('..', import.meta.url).pathname
  const docs: string[] = []
  const walkDocs = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walkDocs(full)
      else if (entry.name.endsWith('.md')) docs.push(full)
    }
  }
  walkDocs(join(repoRoot, 'docs'))
  docs.push(join(repoRoot, 'README.md'))

  const problems: string[] = []
  const citedFiles = new Set<string>()
  let checked = 0
  const cache = new Map<string, string[]>()

  for (const doc of docs) {
    const body = readFileSync(doc, 'utf8')
    // src/model/project.ts:446 — a real path, not a URL or a bare filename.
    for (const match of body.matchAll(/\b((?:src|test)\/[a-zA-Z0-9._/-]+\.tsx?):(\d+)\b/g)) {
      checked += 1
      const [, path, lineText] = match
      citedFiles.add(path!)
      const line = Number(lineText)
      const target = join(repoRoot, path!)
      if (!existsSync(target)) {
        problems.push(`${doc.replace(repoRoot, '')}: ${path} does not exist`)
        continue
      }
      let lines = cache.get(path!)
      if (!lines) {
        lines = readFileSync(target, 'utf8').split('\n')
        cache.set(path!, lines)
      }
      if (line < 1 || line > lines.length) {
        problems.push(`${doc.replace(repoRoot, '')}: ${path}:${line} is past the end (${lines.length} lines)`)
      } else if (!lines[line - 1]!.trim()) {
        problems.push(`${doc.replace(repoRoot, '')}: ${path}:${line} is blank`)
      }
    }
  }

  assert.deepEqual(problems, [], `stale line references:\n  ${problems.join('\n  ')}`)

  // A guard that matches nothing is a guard that cannot fail, and a count alone
  // is easy to satisfy from one file. Both a floor and a spread are needed: the
  // walkthroughs are the study material, and if they quietly lose their anchors
  // this test should notice rather than pass on a handful of stale ones.
  assert.ok(checked >= 15, `expected the docs to cite source lines often, found ${checked}`)
  assert.ok(
    citedFiles.size >= 8,
    `expected the citations to span the codebase, found ${citedFiles.size} file(s): ${[...citedFiles].join(', ')}`,
  )
  console.log(
    `  ${checked} file:line references across ${docs.length} docs, ` +
      `spanning ${citedFiles.size} source files, all resolve`,
  )
}

/**
 * Relative links between documents must resolve.
 *
 * Distinct from the `docs/…#anchor` guard above, which only looks at references
 * written *inside source comments*. Documentation links to documentation, and
 * those are the links a newcomer actually clicks.
 *
 * This was added after two were found broken on the first run: a trace in
 * `docs/traces/` citing `decisions/0004-…` resolves relative to its own
 * directory, so it needed `../decisions/`. A link that renders fine and 404s on
 * click is the worst kind of documentation bug, because the text around it
 * still reads well.
 */
{
  const repoRoot = new URL('..', import.meta.url).pathname
  const markdown: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.md')) markdown.push(full)
    }
  }
  walk(repoRoot)

  const problems: string[] = []
  let checked = 0

  for (const doc of markdown) {
    const body = readFileSync(doc, 'utf8')
    for (const match of body.matchAll(/\[[^\]]*\]\(([^)\s#]+)(#[^)\s]*)?\)/g)) {
      const target = match[1]!
      if (/^(https?:|mailto:)/.test(target)) continue
      checked += 1
      if (!existsSync(join(doc, '..', target))) {
        problems.push(`${doc.replace(repoRoot, '')} -> ${target}`)
      }
    }
  }

  assert.deepEqual(problems, [], `broken relative links:\n  ${problems.join('\n  ')}`)
  assert.ok(checked >= 50, `expected the docs to cross-link heavily, found ${checked}`)
  console.log(`  ${checked} relative links across ${markdown.length} documents, all resolve`)
}
