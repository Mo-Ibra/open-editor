/**
 * Guards the dumbest class of bug in a page split across .html and .ts:
 * referencing an element id that does not exist. The failure surfaces as a
 * null dereference in an unrelated function, minutes later.
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { VIEW, readRepoFile, readView } from './view-paths.ts'

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
  const bin = readView('assetBin')
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
  const app = readView('app')
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
  const files = [VIEW.drag, VIEW.assetBin, VIEW.preview]
  const problems: string[] = []
  for (const rel of files) {
    const code = readRepoFile(rel)
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
    const controller = readView('drag')
    const timeline = readView('timeline')
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
  const timeline = readView('drag')

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
 * A move drag must **clamp**, not reorder.
 *
 * `test/timeline.test.ts` pins the arithmetic — that `placeClip` stops a
 * leftward drag at its predecessor and pushes successors on a rightward one.
 * That test calls the model directly, so it proves the arithmetic is *possible*
 * and not that the handler *does* it. This closes that gap: the move branch must
 * place the dragged clip in its own slot and must **not** call `reorder`, which
 * is what threw the left-hand neighbour to the far side of the lane.
 *
 * Checked from the source, because the alternative is a browser.
 */
{
  const drag = readView('drag')
  const branch = drag.match(/case 'move':[\s\S]*?case 'trim-in':/)?.[0] ?? ''
  assert.ok(branch, "the move branch of onPointerMove should exist")

  assert.match(
    branch,
    /state\.place\(drag\.trackId, drag\.index, start\)/,
    'the move branch must place the dragged clip and let placeClip clamp it',
  )
  assert.doesNotMatch(
    branch,
    /state\.reorder\(/,
    'a move must never reorder — crossing a neighbour made the left clip jump away',
  )
  console.log('  a move places and clamps, and never reorders')
}

/**
 * A trim handle must move the playhead with it.
 *
 * The preview followed a trim-*in* by accident — `sourceTimeAt` reads `clip.in`,
 * so dragging that handle changed the source time being decoded. `out` is not in
 * that expression, so a trim-*out* froze the picture for the whole gesture, and
 * once the new out-point passed the playhead the clip ended before the playhead
 * did and the preview showed whatever came next.
 *
 * Asserted from the source: the handler needs a live `PointerEvent` and a canvas,
 * and neither exists here.
 */
{
  const drag = readView('drag')
  const trim = drag.match(/case 'trim-in':[\s\S]*?\n {6}\}/)?.[0] ?? ''
  assert.ok(trim, "the trim branch of onPointerMove should exist")

  assert.match(
    trim,
    /state\.seek\(/,
    'a trim must move the playhead, or the preview shows a frame that is no longer being cut',
  )
  // The seek must be in TIMELINE space. `sourceT` is a source time, and feeding
  // it to `seek` — which walks the timeline — showed the wrong frame (or a gap)
  // for every clip whose source in-point did not equal its timeline start.
  assert.match(
    trim,
    /state\.seek\(drag\.kind === 'trim-out' \? Math\.max\(trackStartTime, edge - frame\) : trackStartTime\)/,
    'the trim preview must seek timeline space, not the source time',
  )
  assert.doesNotMatch(trim, /state\.seek\([^)]*sourceT/, 'a source time must never be seeked as a timeline position')
  assert.match(trim, /const frame = 1 \/ state\.outputFps\(\)/, 'and one output frame is the right distance')

  // The move branch deliberately does NOT seek: dragging a clip must not move the
  // playhead, which is what every editor does and what makes the playhead a
  // measurement rather than a follower.
  const move = drag.match(/case 'move':[\s\S]*?case 'trim-in':/)?.[0] ?? ''
  assert.doesNotMatch(
    move,
    /state\.seek\(/,
    'dragging a clip must not drag the playhead with it — that is a different gesture',
  )
  console.log('  a trim moves the playhead; a move does not')
}

/**
 * There is no end-only snap target, and there must not be one again.
 *
 * `snapMove` used to take a second list of targets that only the *end* edge could
 * pull to — the next clip's start, so a clip could butt forward against it. It was
 * dead code three times over:
 *
 *  - the clip it named is *pushed* by the move, so it travels with the drag, and
 *    ADR-11's rule is that a target which travels with the drag is the vibration;
 *  - the list was captured once at pointerdown, so its time froze while its clip
 *    walked away — out of range after about a tenth of a second of drag;
 *  - and a derived position means a clip dragged right *pushes* its successor
 *    rather than colliding with it, so there is nothing to butt against.
 *
 * Removing a parameter is not something a behavioural test notices, so this is
 * here to keep it removed.
 */
{
  const model = readFileSync(new URL('../src/model/snapping.ts', import.meta.url), 'utf8')
  const drag = readView('drag')

  const snapMove = model.match(/export function snapMove\([\s\S]*?\): MoveSnap \| null/)?.[0] ?? ''
  assert.ok(snapMove, 'snapMove should exist')
  assert.doesNotMatch(
    snapMove,
    /endTargets/,
    'snapMove must not take an end-only target list — its clip travels with the drag',
  )
  assert.doesNotMatch(drag, /endSnapTargets/, 'and the drag controller must not build one')
  assert.doesNotMatch(drag, /kind === 'clip-start' && t\.clipId === next\.id/, 'nor filter one out of the target list')

  // And the reason it was removed should stay written down, or it will look like
  // an oversight rather than a decision.
  assert.match(
    model,
    /no end-only target list/,
    'the reason snapMove has no end-only targets belongs in the file, next to it',
  )
  console.log('  there is no end-only snap target, and the reason why is recorded')
}

/**
 * Waveform previews must be warmed by *asset*, not by clip.
 *
 * The effect in `Timeline.tsx` that asks for peaks used to iterate the audio lane.
 * Keyed on the lane it re-ran on every `pointermove` of an audio-lane drag —
 * because a drag rewrites the lane — and `peaksFor` only short-circuits once the
 * first pass has *finished*. Sixty entries in a one-second drag, each walking the
 * whole decoded buffer.
 *
 * Peaks belong to a file. A clip's trim says nothing about its waveform, so the
 * work has to be keyed on something a trim cannot move.
 */
{
  const timeline = readView('timeline')
  const warm = timeline.match(/createEffect\(\(\) => \{[\s\S]*?\n {2}\}\)/)?.[0] ?? ''
  assert.ok(warm, 'the peaks-warming effect should exist')

  assert.match(
    warm,
    /state\.assetIds\(\)/,
    'the effect must be keyed on the asset list, or an audio-lane drag re-enters it per frame',
  )
  assert.doesNotMatch(
    warm,
    /project\.audio/,
    'iterating the audio lane is the bug: a drag rewrites the lane 60 times a second',
  )
  assert.match(warm, /peaksFor/, 'and it must still ask for the peaks')

  // The other half: while a pass is in flight, further callers join it rather
  // than starting their own. Asserted structurally as well as behaviourally,
  // because the map is the whole mechanism.
  const assets = readFileSync(new URL('../src/app/store/assets.ts', import.meta.url), 'utf8')
  assert.match(assets, /peaksPending/, 'the in-flight map should exist')
  assert.match(
    assets,
    /const running = peaksPending\.get\(assetId\)\n\s*if \(running\) return running/,
    'a caller arriving during a decode must join the run already in flight',
  )
  assert.match(
    assets,
    /finally \{\s*\n\s*peaksPending\.delete\(assetId\)/,
    'and the entry must be cleared afterwards, so a failed pass is not cached forever',
  )
  console.log('  waveform peaks are warmed per asset, and shared while in flight')
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
 * Also pinned: a plain wheel pans the timeline sideways. The timeline has no
 * vertical overflow of its own, so the gesture would otherwise do nothing —
 * panning is a gesture people already have, and this is how it is honoured.
 */
{
  const timeline = readView('drag')

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
    /scroller\.scrollLeft \+=/,
    'a plain wheel must pan the timeline horizontally',
  )
  assert.match(
    handler,
    /mustScrollVertically[\s\S]{0,80}return/,
    'but a wheel must stay native when there is vertical content to scroll',
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
  // The anchor needs the pointer position, which only exists on the event, so
  // it must be captured there and used in the frame callback.
  assert.match(handler, /wheelClientX = event\.clientX/, 'the pointer position must be recorded from the event')

  const apply = timeline.match(/function applyPendingZoom[\s\S]*?\n  \}/)?.[0] ?? ''
  assert.ok(apply, 'applyPendingZoom should exist')
  assert.match(apply, /pendingNotches = 0/, 'and reset the accumulator, or it grows forever')
  assert.match(apply, /scrollLeftAfterZoom\(/, 'the wheel must zoom about the pointer, not the origin')
  // The slider has no pointer, so its zoom is placed by the effect instead.
  assert.match(timeline, /clientWidth \/ 2/, 'non-wheel zoom anchors on the viewport centre')

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
  const read = readView('drag')
  const written = [
    readView('clip'),
    readView('lane'),
    readView('timeline'),
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
  assert.match(written, /data-track=\{props\.trackId\}|data-track="|data-track=\{/, 'a track must render data-track')
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

/**
 * The panel and picture controls must stay wired.
 *
 * Every one of these is a feature that "works" while being unreachable: a
 * button nobody renders, a shortcut whose action is `undefined`, a picture that
 * can be hidden with no way back. The layout store has supported collapsing the
 * sidebar and the timeline since before the buttons existed — via a
 * double-click on a 1px hairline — which is precisely how a feature can be
 * complete and invisible at the same time.
 *
 * The transport height is checked here too, because `PREVIEW_TRANSPORT_ONLY`
 * duplicates it. A constant that has to match a class in another file is a
 * constant that will eventually not.
 */
{
  const read = (file: string): string => readFileSync(join(repoRootFor(), file), 'utf8')
  const app = readView('app')
  const transport = readView('transport')
  const layout = read('src/app/store/layout.ts')

  // The two collapse buttons exist and call the real actions.
  for (const [file, panel, action] of [
    [VIEW.assetBin, 'media', 'toggleSidebar'],
    [VIEW.toolbar, 'timeline', 'toggleTimeline'],
  ] as const) {
    const source = readRepoFile(file)
    assert.match(source, new RegExp(`PanelToggle\\b`), `${file} must render a PanelToggle`)
    assert.match(source, new RegExp(`panel="${panel}"`), `${file} must name its panel`)
    assert.match(source, new RegExp(`layout\\.${action}\\(\\)`), `${file} must call ${action}`)
  }

  // The picture controls, in the transport.
  assert.match(transport, /onTogglePicture/, 'the transport must offer a picture toggle')
  assert.match(transport, /onToggleFullscreen/, 'and a full screen toggle')
  assert.match(transport, /data-preview-action="picture"/, 'both need a hook for the tests to find')
  assert.match(transport, /data-preview-action="fullscreen"/, '')

  // The store actually implements the three actions the UI calls.
  for (const action of ['toggleSidebar', 'toggleTimeline', 'togglePicture']) {
    assert.match(layout, new RegExp(`function ${action}\\(`), `layout must define ${action}`)
  }

  // The duplicated constant must still match the class it stands in for.
  const { PREVIEW_TRANSPORT_ONLY } = (await import('../src/app/store/layout.ts')) as {
    PREVIEW_TRANSPORT_ONLY: number
  }
  assert.match(
    transport,
    new RegExp(`h-\\[${PREVIEW_TRANSPORT_ONLY}px\\]`),
    `PREVIEW_TRANSPORT_ONLY is ${PREVIEW_TRANSPORT_ONLY}px, so the transport must be ` +
      `h-[${PREVIEW_TRANSPORT_ONLY}px] — not a rem-based Tailwind step, which would ` +
      'change under a root font size',
  )

  // And the full-screen seam is the only place a request is made, so the menu
  // and the shortcut cannot drift from the button.
  const fullscreen = readView('fullscreen')
  assert.match(fullscreen, /requestFullscreen/, 'the seam must own the request')
  assert.equal(
    app.includes('requestFullscreen'),
    false,
    'App must not call requestFullscreen directly; it would bypass the active-state tracking',
  )
  console.log('  panel and picture controls are all wired')
}

// Small helper so the block above reads as one thing.
function repoRootFor(): string {
  return new URL('..', import.meta.url).pathname
}

/**
 * The preview's 2D context cache must stay keyed on its element.
 *
 * This is a regression guard for a bug that only showed up in a terminal: after
 * hiding the picture and showing it again, `<Show>` unmounted the canvas and the
 * `ref` rebound to a new element, but the cached context still pointed at the
 * destroyed one. Every render then drew into a canvas that was no longer in the
 * document, and the health check printed
 *
 *     layout: canvas on-screen 0x0 at 0,0  display= visibility= opacity=
 *
 * every five seconds for the rest of the session. The empty `display=` is the
 * tell: `getComputedStyle` on a *detached* element returns empty strings.
 *
 * Source-level, because the failure needs a real canvas lifecycle and a real
 * unmount to reproduce, and no unit test here has a DOM.
 */
{
  const preview = readView('preview')

  assert.match(
    preview,
    /if \(cachedContext && contextFor === canvas\)/,
    'the context cache must be keyed on the element it came from',
  )
  assert.match(preview, /contextFor = canvas/, 'and must record which element it belongs to')
  assert.doesNotMatch(
    preview,
    /if \(cachedContext\) return cachedContext/,
    'a bare context cache outlives the canvas when the picture is hidden and shown again',
  )

  // And drawing must stop when there is nothing on screen to draw onto.
  assert.match(
    preview,
    /if \(props\.layout\.pictureHidden\(\)\) \{[\s\S]{0,120}return/,
    'draw() must bail out while the picture is hidden, not render into a dead canvas',
  )

  // The diagnostics must know the difference between "broken" and "requested".
  const diag = readFileSync(join(repoRootFor(), 'src/dev/preview-diagnostics.ts'), 'utf8')
  assert.match(diag, /if \(f\.layout\.hidden\) return null/, 'a hidden picture must not raise a fault')
  console.log('  the preview context cache is keyed on its element, and hidden is not a fault')
}

/**
 * A collapsed panel's own control must be reachable.
 *
 * Three separate bugs hid behind "the collapse button is there":
 *
 * 1. The button lived *inside* the panel header, and a collapsed panel is 0px
 *    with `overflow-hidden` — so it was clipped out of existence. `elementFromPoint`
 *    returned the panel next door. The user could collapse a panel and not bring
 *    it back, except by double-clicking a 1px hairline.
 * 2. The tab that replaced it was `pointerdown` *and* `click`, and the two fought:
 *    pointerdown expanded the panel, then the click collapsed it again.
 * 3. The tab was a child of the 0-height timeline, so the same `overflow-hidden`
 *    clipped it — in the DOM, with a real box, responding to `.click()`, and
 *    unclickable by a human.
 *
 * And a fourth, found while fixing these: `onClick={collapsed() ? onToggle : undefined}`
 * did not fire at all. A raw click reached the element and the handler never ran.
 * A conditional *handler* is a value the delegated dispatcher must read at
 * dispatch time; a branch *inside* the handler has no such dependency. Always
 * attach, and decide inside.
 *
 * These need a real layout to reproduce, so they are source-level guards plus the
 * browser probe described in each comment above.
 */
{
  const resizer = readView('resizer')
  const app = readView('app')

  // A visible tab whenever a panel is collapsed.
  assert.match(resizer, /data-panel-tab=/, 'a collapsed panel must expose a hit-testable tab')
  assert.match(resizer, /<Show when=\{collapsed\(\)\}>\s*<ExpandTab/, 'and render a real tab for it')

  // The handler must be attached unconditionally, or the click silently vanishes.
  assert.doesNotMatch(
    resizer,
    /onClick=\{collapsed\(\)\?/,
    'a conditional onClick does not fire under Solid event delegation — branch inside the handler instead',
  )
  assert.match(resizer, /onClick=\{\(\) => \{[\s\S]{0,200}if \(collapsed\(\)\) props\.onToggle\(\)/, 'always attach, and decide inside')

  // The handle must not live inside the clipped panel.
  const main = app.slice(app.indexOf('<main'), app.indexOf('</main>'))
  // The clipping div must close immediately after the Timeline. If a Resizer
  // appeared between them, the handle would be a child of a 0-height,
  // overflow-hidden box and therefore unclickable.
  assert.match(
    main,
    /overflow-hidden"\s*>\s*<Timeline[\s\S]{0,120}?\/>\s*<\/div>/,
    'the timeline handle must be a sibling of the panel, not a child of a box that clips its overflow',
  )
  // And it is positioned from the bottom, which is the boundary only while the
  // timeline is the last row — the case where it is not rendered at all.
  assert.match(main, /at=\{\{ bottom: layout\.timelineTrack\(\) \}\}/, 'the handle sits on the bottom row boundary')
  console.log('  collapsed panels expose a reachable tab, outside the clipped panel')
}

/**
 * Invariants for the hide/mute, logs and keymap work.
 *
 * Each of these was a bug at least once, and every one of them is invisible to
 * the type checker — a stale element, a racing decode, a timer that removes the
 * wrong row. The browser probes that found them are described at each guard.
 */
{
  const read = (f: string): string => readFileSync(join(repoRootFor(), f), 'utf8')
  const preview = readView('preview')
  const app = readView('app')
  const state = read('src/app/store/state.ts')
  const shortcuts = read('src/app/commands/shortcuts.ts')
  const exporter = read('src/output/exporter.ts')

  // --- a frame that is already decoding must not outlive its clip ----------
  // Intermittent by nature: it depended on whether the decode outlasted the
  // keystroke, so it passed one run and failed the next. Hiding does not move
  // the playhead, so the staleness check cannot see it — and neither can it see a
  // *delete*, which is the same fault by another route.
  //
  // This used to assert a re-check for `hidden` only, which left the other two
  // ways a clip stops being drawable free to paint over the black. It now
  // requires the re-check to go through the one function that owns the decision,
  // so widening the decision widens the guard with it.
  assert.match(
    preview,
    /const current = paintIntentAt\(state\.videoTracks\(\), forTime, unavailable\)/,
    'a decoded frame must re-check what to paint, through the function that decides it',
  )
  assert.match(
    preview,
    /paintIntentAt\(state\.videoTracks\(\), forTime, unavailable\)[\s\S]{0,400}current\.kind === 'blank'/,
    'and it must paint the blank rather than let the decoded frame through',
  )
  assert.doesNotMatch(
    preview,
    /current\?\.clip\.hidden/,
    'a hidden-only re-check is not enough: a deleted clip leaves a gap, which is blank too',
  )

  // --- every blank path must paint, and only a fault may be reported -------
  // A gap used to `explain` and return, which left the previous clip's last frame
  // frozen on the canvas — while the exporter wrote black for the same gap. This
  // is the ADR-1 drift the single render function exists to prevent, and it is
  // only visible in a browser, so it is guarded from the source.
  {
    const intent = readView('paintIntent')
    assert.match(
      preview,
      /function paintBlank\(fault: string \| null, at: number\)/,
      'the preview should have one place that paints black',
    )
    const paintBlank = preview.match(/function paintBlank[\s\S]*?\n {4}\}/)?.[0] ?? ''
    assert.match(paintBlank, /renderBlank\(/, 'and it must actually paint, not just set a flag')
    assert.match(paintBlank, /if \(fault\)/, 'a fault explains itself; a deliberate blank stays silent')
    assert.match(
      intent,
      /if \(!loc\) continue/,
      'a gap is an edit, not a fault — it falls through to a lower track, or black',
    )
    assert.match(
      intent,
      /return \{ kind: 'blank', fault: null \}\s*\}/,
      'and with no clip anywhere below, it is black and silent',
    )
    assert.match(
      intent,
      /if \(loc\.clip\.hidden\) return \{ kind: 'blank', fault: null \}/,
      'and so is a hidden clip',
    )
  }

  // --- fullscreen must be registered from a ref, not onMount --------------
  // `onMount` runs once per component; the stage lives in a `<Show>` that
  // unmounts it. After hide-then-show the seam held the destroyed element and
  // every browser refused the request.
  assert.match(
    preview,
    /ref=\{\(el\) => props\.fullscreen\.register\(el\)\}/,
    'the fullscreen target must be registered by a ref callback, so a new stage replaces the old',
  )
  assert.doesNotMatch(preview, /onMount\(\(\) => props\.fullscreen\.register/, 'onMount never re-runs for a recreated element')

  // --- a notice must expire itself, not the newest one -------------------
  // `slice(0, -1)` removed whichever notice was last, so a burst of them had
  // its earliest timer delete the newest message.
  assert.match(state, /prev\.filter\(\(n\) => n\.id !== notice\.id\)/, 'a notice must be withdrawn by its own id')
  assert.doesNotMatch(state, /setNotices\(\(prev\) => prev\.slice\(0, -1\)\)/, 'expiry must not remove by position')

  // --- the export must agree with the preview about hidden ---------------
  assert.match(exporter, /clipRendersBlack\(seg\.clip, Boolean\(entry\?\.videoSink\)\)/, 'the export decides black by the same rule the preview does')

  // --- the keymap must not be furniture ----------------------------------
  assert.doesNotMatch(
    app.slice(app.indexOf('function StatusFooter')),
    /shortcutLegend|props\.rows/,
    'the status footer shows state, not a permanent keymap',
  )
  assert.match(app, /<ShortcutsPanel shortcuts=\{shortcuts\}/, 'the keymap lives in a panel')
  assert.match(app, /<LogPanel onClose=/, 'and the logs are shown, not only copied')
  // `?` must still find it, or moving it made it harder to reach than the thing
  // it replaced.
  assert.match(shortcuts, /keys: \['\?'\]/, 'the keymap needs a key of its own')
  console.log('  hide/mute, logs and keymap invariants hold')
}

/**
 * Dropping must work *anywhere*, and say what it is about to do.
 *
 * The old behaviour was to append to the end of a lane and clamp, so letting go
 * in the middle of the edit did nothing recognisable — the complaint that
 * prompted all of this. The rules that fix it are invariants, and each of them
 * was a bug at least once:
 *
 * - A drop onto a lane, the ruler, or the empty track below the lanes all work.
 *   The lanes do not fill the timeline, and the gaps were dead space.
 * - Overwrite is the default; Shift means insert. Red for one, amber for the
 *   other, because the difference is the whole decision.
 * - A clip fully inside an overwritten span is *removed*. Classifying it as
 *   "straddles the end" produced a clip with out < in — a corrupt clip.
 * - Overwrite re-derives offsets from absolute starts, so a clip after the drop
 *   stays exactly where it was instead of drifting right.
 * - An audio-only file is importable and goes to the audio lane. `loadAsset`
 *   used to throw "has no video track", so the app could not import a voice memo
 *   at all, despite the model having `hasVideo: false` for exactly that case.
 */
{
  const read = (f: string): string => readFileSync(join(repoRootFor(), f), 'utf8')
  const probe = read('src/media/probe.ts')
  const model = read('src/model/project.ts')
  const timeline = readView('timeline')
  const lane = readView('lane')
  const cue = readView('dropCue')
  const assets = read('src/app/store/assets.ts')

  // --- audio-only files are first-class ---------------------------------
  assert.doesNotMatch(
    probe,
    /throw new Error\(`\$\{file\.name\} has no video track`\)/,
    'an audio-only file must not be rejected — the model has hasVideo:false for it',
  )
  assert.match(
    probe,
    /if \(!video\) \{[\s\S]*?if \(!audio\)[\s\S]*?hasVideo: false[\s\S]*?hasAudio: true/,
    'and it must produce an asset with hasVideo:false rather than throwing',
  )

  // --- the six cases of an overwrite ------------------------------------
  assert.match(model, /s >= start - EPS && e <= end \+ EPS\) \{\s*continue/, 'a clip wholly inside the span is removed')
  assert.match(model, /cursor = cursor \+ offset \+ clipDuration\(clip\)/, 'the cursor is an absolute end, so offsets cannot drift')
  assert.match(model, /export function placeClipAt\(/, 'overwrite and insert share one entry point')

  // --- the whole track is a target -------------------------------------
  assert.match(timeline, /onDragOver=\{onDragOverTrack\}/, 'the track itself accepts a drop')
  assert.match(timeline, /onDrop=\{onDropTrack\}/, '')
  assert.match(timeline, /function trackAtClientY/, 'and a drop between tracks picks the nearest one')
  assert.match(timeline, /state\.dropFiles\(files/, 'a file from the desktop is imported *and* placed')
  const ruler = readView('ruler')
  assert.match(ruler, /onDragOver=\{props\.onDragOver\}/, 'the ruler accepts a drop too')
  assert.match(ruler, /onDrop=\{props\.onDrop\}/, '')
  assert.match(lane, /event\.shiftKey \? 'insert' : 'overwrite'/, 'shift is insert, otherwise overwrite')

  // --- the cue shows the real extent, and says which mode ---------------
  assert.match(cue, /data-drop-caret=\{at\(\)\.mode\}/, 'the caret records the mode, for the tests and for the eye')
  assert.match(cue, /at\(\)\.incoming === true/, 'and hides an extent it does not know')
  assert.match(assets, /const targetTypes: string\[\] = canVideo && canAudio \? \['video', 'audio'\]/, 'a file with both tracks makes a linked pair')
  console.log('  dropping works anywhere, in both modes, for both kinds of file')
}

/**
 * Persistence ordering and storage-shape invariants.
 *
 * Two of these were real bugs, and both were invisible in the type checker, the
 * unit tests, and the *build* — they only showed up when a saved project was
 * actually reopened:
 *
 * - **`MediaLibrary` is a plain `Map`, so it is not reactive.** The media bin's
 *   rows read it with `<Show when={state.entryFor(id)}>`, which evaluates once
 *   and never re-checks. Writing the project *before* rehydrating therefore
 *   created the rows while the library was still empty, and they stayed
 *   invisible: a bin showing its populated branch with nothing in it, while the
 *   clip titles — which read the store — looked perfectly fine.
 * - **Solid merges object writes instead of replacing them.** After `open()`,
 *   the asset keys were readable through the proxy but `project.assets` was
 *   still the same object, so `<For each={Object.keys(project.assets)}>` never
 *   re-ran. `reconcile` does not help; it mutates in place too.
 */
{
  const read = (f: string): string => readFileSync(join(repoRootFor(), f), 'utf8')
  const store = read('src/app/store/project-store.ts')
  const state = read('src/app/store/state.ts')
  const assets = read('src/app/store/assets.ts')

  // Library first, then the project. The reverse produces an empty-looking bin.
  const rehydrateAt = store.indexOf('await rehydrateAll(')
  const writeAt = store.indexOf('deps.write(project)')
  assert.ok(rehydrateAt > 0 && writeAt > 0, 'open() must rehydrate and write')
  assert.ok(
    rehydrateAt < writeAt,
    'the library must be populated before the project is written — the bin reads a plain Map, which is not reactive',
  )

  // The assets map needs something to depend on.
  assert.match(state, /setAssetsRevision\(\(n\) => n \+ 1\)/, 'replacing the project must bump the assets revision')
  assert.match(assets, /deps\.assetsRevision\(\)/, 'and the asset ids must read it, or the bin never re-renders')
  // Every top-level key is written on its own line. Wrapping the whole project
  // in `reconcile` is what blanked `assets` and `version` once, because a
  // reconciler sets every key the target does not mention to `undefined`.
  for (const key of ['version', 'assets', 'tracks', 'captions']) {
    assert.match(state, new RegExp(`applyProject\\('${key}'`), `${key} is written explicitly`)
  }
  assert.doesNotMatch(
    state,
    /applyProject\(reconcile\(\{|applyProject\(reconcile\(next\b/,
    'the project must never be handed to a reconciler as a whole',
  )
  // `reconcile` is now used on the assets map, which is the one place it is
  // right: a plain set *merges* and can only add keys, so starting a new project
  // left the old project's files in the bin and in the saved file. It is safe
  // only because that map is complete, never partial.
  assert.match(state, /applyProject\('assets', reconcile\(next\.assets\)\)/, 'the assets map is replaced, not merged')

  // Bytes are written once, at import, and never on a save.
  assert.match(assets, /void rememberMedia\(entry\.asset\.id, file\)/, 'media must be stored when a file is imported')
  // Only the body of `saveNow`. Slicing to the end of the file would match
  // `rememberMedia`'s *definition*, which is exactly where the write belongs.
  const saveStart = store.indexOf('async function saveNow')
  const saveEnd = store.indexOf('\n  /**', saveStart)
  const savePath = store.slice(saveStart, saveEnd > 0 ? saveEnd : undefined)
  assert.ok(savePath.length > 0, 'found the save path')
  assert.doesNotMatch(savePath, /rememberMedia|putMedia/, 'a save must never rewrite the media')
  assert.match(savePath, /saveProject\(/, 'and it must write the edit')
  console.log('  persistence rehydrates before it writes, and the assets map is not reactive either')
}

/**
 * The project list, and the one prompt the app is allowed to show.
 *
 * `beforeunload` is the guard worth having. The browser's "leave site?" dialog
 * is the most irritating thing an app can do, and it stops working the first
 * time it appears for no reason — people learn to click through it. So it is
 * gated on the save state, and the gate is the assertion.
 */
{
  const read = (f: string): string => readFileSync(join(repoRootFor(), f), 'utf8')
  const app = readView('app')
  const shortcuts = read('src/app/commands/shortcuts.ts')
  const panel = readView('projectPanel')
  const store = read('src/app/store/project-store.ts')
  const media = readView('mediaPanel')
  const transfer = readView('transfer')

  // --- the prompt, and the gate -----------------------------------------
  assert.match(app, /addEventListener\('beforeunload'/, 'the prompt exists')
  assert.match(
    app,
    /if \(state_ !== 'dirty' && state_ !== 'error'\) return/,
    'and it is gated on there being unsaved work — an ungated prompt is worse than none',
  )
  assert.match(app, /e\.returnValue = ''/, 'setting returnValue is what Chromium actually checks')
  assert.doesNotMatch(
    app,
    /addEventListener\('beforeunload',[^\n]*\)\s*\n\s*\n\s*onMount/,
    'and it must be removed on cleanup, or a remount stacks listeners',
  )
  assert.match(app, /removeEventListener\('beforeunload'/, '')

  // --- the keys ---------------------------------------------------------
  assert.match(shortcuts, /keys: \['s'\],\s*\n\s*accel: true,[\s\S]{0,200}save now/, '⌘S saves now')
  assert.match(shortcuts, /keys: \['o'\], accel: true, hint: '⌘O', label: 'projects'/, '⌘O opens the list')
  // The plain `s` (split) must still be reachable, which is the whole point of
  // the accel check in the matcher.
  assert.match(shortcuts, /keys: \['s'\],\s*\n\s*hint: 'S',\s*\n\s*label: 'split'/, 'plain s is still split')

  // --- stage 3: the folder walk, and the cost of it -----------------------
  const folder = readView('folder')

  // The chain this replaced was hand-maintained, and two test files were added
  // without being added to it — so the suite reported green while never running
  // them. A glob cannot be left out of.
  assert.match(read('package.json'), /"test":[^\n]*test\/\*\.test\.ts/,
    'the test script globs the test files, so a new one cannot be left out')

  // The loop, not a single call. `readEntries` returns at most ~100 entries and
  // reports no error, so one call silently truncates a large folder to a batch.
  assert.match(folder, /while \(;;\)|for \(;;\)/, 'the reader is drained')
  assert.match(folder, /if \(batch\.length === 0\) break/, 'until it says it is done')
  assert.match(folder, /webkitGetAsEntry/, 'a dropped folder is walked, not just its top level')
  assert.match(folder, /webkitdirectory/, 'and a folder can also be picked')
  // Both paths are needed, not one with a fallback: Firefox has no directory
  // picker, so a drop is its only way to give this app a folder.
  assert.match(folder, /MAX_FOLDER_FILES = \d+/, 'a dragged home directory is bounded')
  assert.match(folder, /MAX_FOLDER_DEPTH = \d+/, 'as is a symlink loop')

  // The cost claim, asserted. A folder is gigabytes, so anything hashed before
  // the free name-and-size filter is minutes of frozen tab.
  const mediaStatus = read('src/app/store/media-status.ts')
  assert.match(mediaStatus, /export function prefilter/, 'the cheap filter is a pure function')
  const relinkFrom = store.slice(store.indexOf('async function relinkFromFolder'))
  assert.match(relinkFrom, /prefilter\([\s\S]{0,400}?worth\.set/, 'the filter runs before anything is read')
  assert.match(relinkFrom, /await fingerprintOf\(/, 'and only survivors are hashed')
  assert.match(relinkFrom, /const items = planBatch\(/, 'and the assignment is decided purely')
  assert.match(relinkFrom, /if \(!certain\) continue/, 'only a certain match is applied')
  assert.match(relinkFrom, /const proposals = items\.filter\(\(i\) => i\.certain === null/,
    'everything weaker is returned for a person to confirm')

  // One file backs at most one asset. Without it "use this" attaches the same
  // file twice, which is an edit that saves cleanly and is not the one you made.
  assert.match(mediaStatus, /claimed\.add\(file\.assetId\)/,
    'a proposal claims its file, so no file is offered twice')

  // --- the media review screen -------------------------------------------
  assert.match(app, /<MediaPanel[\s\S]{0,160}?state=\{state\}/, 'the review screen is reachable')
  assert.match(app, /setMediaOpen\(true\)/, 'and something opens it')
  assert.match(app, /report\.missing\.length > 0 \|\| report\.rejected\.length > 0/,
    'the import opens it only when the import could not settle itself')
  assert.match(app, /openMedia: \(\) => setMediaOpen\(true\)/, '⌘M opens it too')
  assert.match(media, /data-media-row=\{m\.assetId\}/, 'every asset gets a row')
  assert.match(media, /data-relink=\{m\.assetId\}/, 'and a way to relink it')
  assert.match(media, /data-pick-folder/, 'a whole folder can be checked at once')
  assert.match(media, /filesFromDrop\(e\.dataTransfer\)/, 'or dropped on the panel')
  // A drop must be cancelled, or the browser navigates to the folder and the
  // app is gone with no way back but a reload.
  assert.match(media, /onDragOver=\{\(e\) => \{\s*\n?\s*e\.preventDefault\(\)/,
    'the drop is cancelled, so the browser does not navigate to the folder')
  assert.match(media, /data-progress/, 'the work reports itself')
  assert.match(media, /data-accept=\{item\.assetId\}/, 'a proposal takes an explicit yes')
  assert.match(media, /Nothing has been attached\./, 'and the panel says so up front')
  // The relink must show its reasoning either way, or a refusal is invisible and
  // the user assumes the button is broken.
  assert.match(media, /not attached — \$\{v\(\)\.reason\}/, 'a refusal says so on the row')
  assert.match(media, /It was left exactly as it was\./, 'and says the old file survived')

  // The one invariant the screen rests on: nothing is ever attached without
  // checking. The decision lives in a pure function so it is unit tested; this
  // only asserts the panel calls it rather than deciding for itself.
  assert.match(store, /decideRelink\(/, 'relinking goes through the certainty rule')
  assert.match(transfer, /export async function chooseOneMediaFile/, 'and asks for a File, not text')

  // --- the panel, and the things it must not skip -----------------------
  // Matched on the props that matter rather than the whole opening tag, so
  // adding a prop to the panel does not read as the panel disappearing.
  assert.match(app, /<ProjectPanel[\s\S]{0,200}?state=\{state\}/, 'the panel is reachable')
  assert.match(app, /onClick=\{props\.onOpenProjects\}/, 'and the topbar indicator opens it')
  assert.match(panel, /data-projects-panel/, 'it has a hook for the tests')
  // Deleting takes a project's media with it and has no undo, so it needs a
  // second click. One click is how people lose work.
  assert.match(panel, /setConfirming\(p\.id\)/, 'delete asks first')
  assert.match(panel, /Really delete/, 'and says what the button does')
  // `remove` must appear exactly once, inside the "Really delete" button. Two
  // calls would mean one of them is a single click away from deleting a project
  // and its media with no undo.
  const removes = panel.match(/projects\(\)\.remove\(/g) ?? []
  assert.equal(removes.length, 1, `remove() must be called from one place, found ${removes.length}`)
  // The call sits in the button's `onClick`, which JSX emits *before* its label,
  // so the confirm branch is a window around the call rather than after it.
  const at = panel.indexOf('projects().remove(')
  // The confirm button is the only danger-styled one, and its `onClick` is the
  // only `remove` call. Matching the style is sturdier than matching the label,
  // which JSX emits after the handler.
  const around = panel.slice(Math.max(0, at - 320), at + 120)
  assert.match(around, /!border-danger/, 'and that one place is the danger-styled confirm button')
  // The cost of the design, on screen.
  assert.match(panel, /projects hold a\s*\n?\s*copy of their media/, 'the storage cost is stated, not hidden')
  assert.match(panel, /may reclaim this project/, 'including that the browser may evict it')

  // --- the store can actually do it -------------------------------------
  for (const fn of ['open', 'startNew', 'rename', 'duplicate', 'remove', 'refreshList', 'refreshUsage']) {
    assert.match(store, new RegExp(`\\b${fn}\\b`), `the store exposes ${fn}`)
  }
  assert.match(store, /await saveNow\(\)/, 'switching or duplicating saves the current project first')
  console.log('  the project list is wired, and the unload prompt is gated on unsaved work')
}

/**
 * Switching projects must actually switch.
 *
 * Found by driving the panel: after "New", the timeline was empty but the media
 * bin still showed a row, and starting a project left the previous project's
 * files inside the new one. Two different reasons, both worth pinning:
 *
 * - **Solid merges object writes.** A plain `set('assets', {})` adds nothing and
 *   removes nothing, so the old keys were still there. Only a reconciler deletes,
 *   and that is safe on *this* key precisely because the map is complete.
 * - **The library is not reactive and not cleared.** Its entries hold live
 *   decoders, so carrying them into another project leaks them and keeps the old
 *   files visible.
 */
{
  const state = readFileSync(join(repoRootFor(), 'src/app/store/state.ts'), 'utf8')
  const store = readFileSync(join(repoRootFor(), 'src/app/store/project-store.ts'), 'utf8')
  const library = readFileSync(join(repoRootFor(), 'src/media/library.ts'), 'utf8')

  assert.match(
    state,
    /applyProject\('assets', reconcile\(next\.assets\)\)/,
    'a plain set merges, so the assets map needs a reconciler to actually empty',
  )
  // A `clear()` that only dropped the maps would leak the decoders.
  assert.match(library, /clear\(\): void \{[\s\S]{0,200}input\.dispose\(\)/, 'clearing the library must dispose its inputs')
  assert.match(store, /deps\.releaseLibrary\(\)/, 'switching and starting a project must release the old library')
  // Scoped to the function body, not a character window: the `unlessBusy` branch
  // sits between the signature and the call, and a window that happened to stop
  // short of it would fail for a reason that has nothing to do with the bug.
  const startNewAt = store.indexOf('async function startNew')
  const startNewBody = store.slice(startNewAt, store.indexOf('\n  /**', startNewAt))
  assert.ok(
    startNewBody.includes('releaseLibrary()'),
    'a new project must release the old decoders before it is written',
  )
  console.log('  switching projects clears the assets map and the decoders')
}

/**
 * The portable project file: the format, and the one rule about matching.
 *
 * The rule is the important part. An exported project carries fingerprints and no
 * media, and on another machine it has to find its way back to the files. If the
 * matcher claims a certainty it does not have, the user gets an export that looks
 * right and is not — the worst outcome a video editor can produce, because
 * nothing about it looks wrong.
 *
 * So: **only an identical hash may be applied without asking**, and a file that
 * is missing is still imported, because the edit is the irreplaceable part.
 */
{
  const read = (f: string): string => readFileSync(join(repoRootFor(), f), 'utf8')
  const file = read('src/app/store/project-file.ts')
  const prints = read('src/app/store/fingerprint.ts')
  const app = readView('app')
  const shortcuts = read('src/app/commands/shortcuts.ts')
  const transfer = readView('transfer')

  // --- the format is plain, versioned, and has no paths in it ------------
  assert.match(file, /export const EXPORT_FORMAT = 'open-editor\.project'/, 'the format is named')
  assert.match(file, /export const EXPORT_FORMAT_VERSION = \d+/, 'and versioned on its own')
  // The envelope's fields, exactly. A `path` or `directory` key appearing here
  // would be a bug twice over: it means nothing on another machine, and honouring
  // one from a file the user opened is an attack surface.
  const envelope = file.slice(file.indexOf('export interface ProjectFile'), file.indexOf('/** Build the envelope'))
  const fields = [...envelope.matchAll(/^  (\w+)\??:/gm)].map((m) => m[1])
  assert.deepEqual(
    fields.sort(),
    ['app', 'format', 'formatVersion', 'media', 'name', 'playhead', 'project', 'savedAt', 'selection'],
    'the envelope carries only these fields — and no path, so a file opened from ' +
      'elsewhere cannot steer this one at anything on this machine',
  )
  // A file from a newer build is refused, and the message reassures.
  assert.match(file, /exported by a newer version/, 'and says so')
  assert.match(file, /has not been changed/, 'without blaming the file')
  // The model keeps its shape: fingerprints live beside the project.
  assert.match(file, /media: Record<string, ExportedMedia>/, 'fingerprints sit in their own bag')
  assert.match(file, /const project = migrateProject\(/, 'and the model still gets what it expects')

  // --- the ladder: certainty is earned ------------------------------------
  assert.match(prints, /isCertain[\s\S]{0,120}kind === 'identical'/, 'only identical is certain')
  assert.match(
    prints,
    /want\.quickHash === candidate\.quickHash && want\.size === candidate\.size/,
    'identity needs the hash *and* the size, not the hash alone',
  )
  assert.match(prints, /content differs/, 'and a hash disagreement is a definite no, not a proposal')
  assert.match(prints, /not verified/, 'a fallback match admits it was not verified')

  // --- import never loses the edit ---------------------------------------
  const store = read('src/app/store/project-store.ts')
  assert.match(store, /const attached/, 'an import reports what it found')
  assert.match(store, /const missing/, 'and what it did not')
  assert.match(store, /isCertain\(matchFingerprint/, 'only a certain match is applied without asking')
  // A near-miss is recorded and rejected, not offered. The decision is the
  // user's: different bytes means the cuts were made against something else.
  assert.match(store, /const rejected: \{ name: string; reason: string \}\[\]/, 'near-misses are recorded with their reason')
  assert.match(store, /if \(!certain && candidates\.length > 0\)/, 'and only a certain match is ever attached')

  // --- the keys, and one implementation ---------------------------------
  assert.match(shortcuts, /keys: \['e'\], accel: true, hint: '⌘E', label: 'export project file'/, '⌘E exports')
  assert.match(shortcuts, /keys: \['i'\], accel: true, hint: '⌘I', label: 'import project file'/, '⌘I imports')
  assert.match(app, /exportProject: \(\) => void runExport\(\)/, 'the key and the button share one path')
  assert.match(transfer, /chooseSaveTarget/, 'the save picker is opened before the slow hashing, to keep the gesture')
  assert.match(
    transfer,
    /webkitdirectory|type="file"/,
    'and the universal path is a real input element, so this is not Chromium-gated',
  )
  console.log('  the portable project file is plain, versioned, and only ever certain when it is')
}
