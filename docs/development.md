# Development

## Commands

```bash
npm run dev         # dev server, http://localhost:5173
npm test            # logic suites (Node) then component suites (Vitest + jsdom)
npm run test:logic  # the pure-logic suites only
npm run test:ui     # the .tsx component suites only
npm run test:watch  # component suites in watch mode
npm run typecheck   # tsc --noEmit
npm run build       # typecheck + production build
```

`npm test` runs two runners, on purpose. The **logic** suites are plain
`node --experimental-strip-types` scripts with `node:assert`, so the pure model,
geometry and export maths need no test-framework dependency and no browser. The
**component** suites are `.tsx` and need a DOM, so they run under Vitest with
jsdom. Keeping them separate means the fast suite stays fast and the DOM suite
stays honest about what it needs.

## Logging

`debug.ts` forwards browser logs to the dev-server terminal. The browser is
opened once and left alone.

```
http://localhost:5173/__debug        the log viewer
```

In-app, `log.debug/info/warn/error` writes to both the console and the ring
buffer. This exists because *"send me the console output"* is a terrible
debugging loop.

## Running the tests

`npm run test:logic` globs `test/*.test.ts`. It used to be a hand-written `&&`
chain of 20 commands, and two test files were added without being added to the
chain — so the suite reported green while never running them. **Add a test file,
do not edit the script.** A guard in `test/dom.test.ts` asserts the glob is still
there.

`npm run test:ui` globs `test/components/*.test.tsx` and runs them under Vitest.
The Node runner strips types and cannot load `.tsx` at all, so before this the
entire UI was untested by construction — which is how a fixed timeline height, a
media row that survived deletion, and a scroller that never scrolled all shipped
green. `test/setup.ts` supplies the jsdom shims the components actually call
(`ResizeObserver`, `PointerEvent`, pointer capture, `matchMedia`, rAF); add to it
when a new component needs another browser API.

## Layout of the tests

| Suite | Covers |
|---|---|
| `model.test.ts` | Links, gaps, duplication, derived positions, the audio-only mute rule |
| `selection.test.ts` | Multi-select policy, including pruning of deleted clips |
| `store.test.ts` | The project store survives an edit (see below) |
| `codecs.test.ts` | Format negotiation, including the Linux no-AAC case |
| `exporter.test.ts` | Frame↔time mapping, source vs output timestamps |
| `export-audio.test.ts` | The A/V sync assertions |
| `snapping.test.ts` | All ten snapping acceptance criteria, asserted *from the source* |
| `layout.test.ts` | Panel clamping, collapse, restore, corrupt preferences |
| `peaks.test.ts` | Waveform downsampling preserves extremes |
| `frame-cache.test.ts` | Frame reuse and staleness |
| `dom.test.ts` | Structural guards — see below |
| `components/*.test.tsx` | Rendered UI, under Vitest + jsdom: modal focus, the resizer tab, the context menu, the scrubber, the media bin |

## Two kinds of test, and why both exist

### Behavioural tests

Ordinary assertions on pure functions. `model/project.ts` and `model/snapping.ts` import
nothing from the app and touch no Web API, so they run in Node unmodified. That
separation is not incidental — it is the reason these tests are cheap enough to
write first.

### Structural tests

Some failures are invisible to a type checker *and* to any test that does not run
a browser. They are real, they have all shipped, and a unit test cannot see them.
So `test/dom.test.ts` reads the source and the built CSS instead.

| Guard | The bug it exists for |
|---|---|
| Singleton panels rendered exactly once | Two live `<Timeline>`s, both wired to the same state |
| Context menu bound to right-click only | The menu opened on *every left click* |
| No invalid CSS in the build | `shadow-[…#ffffff/45]` compiled to `var(--tw-…)/45`, which browsers discard — the ring silently never drew |
| No `reconcile` on the project store | `reconcile` sets any key the target omits to `undefined`, which deleted the entire asset library on every edit |
| Only one exported snapping function | A move-path helper that would invite re-wiring the move arm to snap |

**Verify a structural guard by breaking it.** Every guard above was confirmed to
fail when the bug is reintroduced, and to pass when it is fixed. A guard that has
never been seen red is not a guard.

### Watch out: Tailwind scans comments

A test that documents a broken class in a comment is enough to make Tailwind
*generate* that class. `index.css` therefore has `@source not '../test'` — tests
are not UI, and nothing under `test/` should be able to reach the browser.

## Adding a test

1. **Is the logic pure?** If it can be, make it so first. `model/project.ts`,
   `model/snapping.ts`, `output/codecs.ts` and `media/frame-cache.ts` all exist
   as separate modules
   precisely so this is possible.
2. **Otherwise, can it be asserted structurally?** If the failure mode is
   "invisible to the compiler", a source-level guard is the right tool, not a
   weaker behavioural test.
3. Register the suite in `package.json`'s `test` script, or it will not run.

## Adding a store slice

`state.ts` is a composition root. The behaviour lives in `selection.ts`,
`history.ts`, `assets.ts`, `edits.ts` and `transport.ts`, each of which takes its
dependencies as arguments and returns an object. The pattern:

- The slice owns its own signals, and nobody outside it writes to them.
- It takes the project as an argument to *read*, and explicit callbacks for the
  few things it must *do* (`createHistory` takes a `restore` and an `onRestore`
  rather than reaching for the store).
- Slices take the *interface* of their collaborators, not the whole store.
  `EditDeps` lists six dependencies; that list is the slice's coupling, written
  down, instead of hidden by reaching for a closure.
- `state.ts` presents one flat object under the names the UI already uses, so a
  new slice never forces a change to a component. The slices are an
  implementation detail; `state.ts` is the seam.
- Construction order is load-bearing and is commented at each step. `edits` and
  `transport` need each other, so one holds a deferred `() => transport.…`
  closure. `test/state.test.ts` exists because **a type checker cannot see a
  use-before-assign inside a closure** — it builds the real store instead.

A comment that describes a behaviour the code does not have is worse than no
comment: it is the one failure mode tests written after the fact tend to catch,
because the test is written from the comment. If a test disagrees with the
comment above it, one of them is a bug — work out which before editing either.

For assertions that are about a *decision* rather than a value — "the only
exported snapping function is the trim one" — write the assertion in terms of the
property, not the current implementation, so it survives a refactor.

## Conventions

- **Comments explain *why*.** A comment restating the code is noise. A comment
  recording a measured result, a rejected alternative, or a trap someone already
  fell into is the most valuable thing in the file.
- **Errors are prevented, not detected.** Clamp in `clampClip`; refuse to mute a
  video clip in the model rather than in each caller.
- **Prefer a plain function over a class** unless there is state worth isolating.
  `output/exporter.ts` and `media/library.ts` are the two exceptions, and both exist because
  they own a resource.
- **Never hardcode an output codec**, a container, or a resolution default. All
  three have been wrong already.

## Adding a decision

Write an ADR in `docs/decisions/` with the next unused number, and add a row to
that directory's README. **Never renumber or reuse an ID** — code comments point
at them, and `ADR-4` must mean the same thing forever.


## Projects and storage

| Where | What |
|---|---|
| `app/store/project-format.ts` | The saved-file format and the migration chain. **Pure** — no IndexedDB, no DOM — so it is unit tested in Node. |
| `app/store/persistence.ts` | The IndexedDB layer: `projects`, `blobs`, `meta`. No mediabunny, no DOM. |
| `app/store/project-store.ts` | What is open, what is saved, what is missing. Autosave, rehydration, boot. |
| `app/view/ProjectPanel.tsx` | The list. `⌘O`, or the topbar's save indicator. |
| `app/view/MediaPanel.tsx` | The media review screen. `⌘M`. See below. |

Two rules when touching this area:

1. **The library must be rehydrated *before* the project is written.**
   `MediaLibrary` is a plain `Map` and therefore not reactive; the media bin's
   rows read it with `<Show when={entry()}>`, which evaluates once and never
   re-checks. Write the project first and the rows are created against an empty
   library, so they stay invisible.
2. **A whole-project write is key by key, and only the assets map is
   reconciled.** A plain set merges (it cannot remove keys, so a new project
   inherits the old one's files); a reconciler blanks any key the target omits
   (which once deleted the media library). The assets map is safe to reconcile
   because it is complete.

### Verifying persistence in a browser

**Do not verify it with `--virtual-time-budget`.** That fast-forwards timers
but starves IndexedDB's *write* transactions while reads still complete, so a
probe reports a working save and a completely broken reload. Two of the "bugs"
fixed while building this were the harness.

The working pattern is real time plus an out-of-band result channel: the probe
waits on `Date.now()` rather than `setTimeout`, keeps the browser alive, and
POSTs its results to a small local sink. A test that reports the opposite of
reality is worse than no test, because it sends you to fix the wrong thing.

## Portable project files

A project file is a plain `.json` you can send to someone. It carries **the edit
and nothing else** — no media, and no paths. Media travels as bytes, on the
machine that has it; the file only says what it is looking for.

```
{ format: 'open-editor.project', formatVersion: 1, savedAt, name,
  project: <the internal saved format>, playhead, selection,
  media: { <assetId>: { size, duration, quickHash } } }
```

| Where | What |
|---|---|
| `media/quick-hash.ts` | Hashing, and whether hashing is possible at all. Lives in the media layer because the library needs it too. |
| `app/store/fingerprint.ts` | The matching ladder: what two fingerprints mean together, and what may be applied without asking. |
| `app/store/project-file.ts` | The envelope, its versioning, and the refusal messages. **Pure.** |
| `app/store/media-status.ts` | What state each asset is in, and whether a relink is allowed. **Pure.** |
| `app/view/MediaPanel.tsx` | The review screen. `⌘M`, or **Media…** in the project list. |
| `app/view/folder.ts` | Folder enumeration: the directory picker and the drop walk. |

### The one rule

**Only identical bytes are attached without asking.** A `quickHash` *and* the
size must both agree. Everything else is reported and left alone.

The ladder, in full:

| Evidence | Result | Attached? |
|---|---|---|
| Hash and size agree | `identical` | **yes**, silently |
| No hash available, name and size agree | `same-name-size` | no — `rejected` |
| No hash available, name and duration agree | `same-name-duration` | no — `rejected` |
| Nothing in common | `none` | no — `missing` |

Attaching a near-match produces a project that saves, exports and re-opens
cleanly and is **not the edit you made** — so it never happens, and the reason is
shown on the row it applies to.

### Three states, and why the reasons differ

`attached`, `rejected`, `missing`. The reasons matter more than the states:

- *"not on this machine"* — go and find the file.
- *"the content differs, despite the same name and size"* — a re-encode. It is
  here, and it is not the one. Telling someone to look for a file they are
  already looking at is how you convince them the tool is broken.

`rejected` is reserved for what genuinely **cannot** be judged — a plausible file
with no hash on either side. That is the case a person is for.

### Hashing needs a secure context

`crypto.subtle` only exists on HTTPS (and `localhost`). On plain HTTP
`quickHash` is `null`, matching falls back to name and size, and every near-match
becomes `rejected` rather than attached. **Deploy over HTTPS.** An honest "we
could not check" beats a hash that is always equal.

### Relinking a whole folder

**Choose folder…** in the media review screen, or drop a folder anywhere on it.
Both are needed, not one with a fallback:

| | Chromium / Safari | Firefox |
|---|---|---|
| `webkitdirectory` | works | **unavailable** |
| folder drop | works | works |

Firefox has no directory picker, so the drop is not a convenience there — it is
the only way to hand the app a folder. Both paths land in `MAX_FOLDER_FILES`
(5000) and `MAX_FOLDER_DEPTH` (12), because a dragged folder can be a home
directory and walking one of those is tens of thousands of `File` handles nobody
asked for.

`readEntries` is **drained in a loop**. It returns at most ~100 entries per call
and signals the end with an empty batch, never an error — so a single call
silently truncates a 250-file folder to 100 and reports success. That is the most
likely bug in this file and it is unit tested.

### The cost model

A folder is gigabytes, so the order is the whole design:

1. `prefilter` — name and size only, which cost nothing, rules out almost
   everything.
2. `quickHash` — **only the survivors are read.** This is asserted in
   `test/dom.test.ts`, because the claim is easy to break by moving a line.
3. `planBatch` — the assignment, purely, unit tested.
4. Only certain matches are applied. Proposals come back for a person.

### One file backs at most one asset

Guaranteed by `planBatch`, and asserted, because it is the property that makes
"Use this" safe: without it, one plausible file is offered to five assets and the
batch attaches it five times — an edit that saves, exports and re-opens cleanly
and is **not the one you made**.

Certain matches claim their file in a first pass, before any proposal is
gathered, so a soft match cannot be offered a file something else already owns.
Proposals are then claimed greedily, most-broken-asset-first.

**The greedy claim is a real limitation.** With equal evidence the asset that
depends on the file most wins, and a better overall assignment is not searched
for. Solving it properly is an assignment problem, and the failure mode of *not*
solving it is one file left for a person to relink by hand — visible, and
reversible. The alternative, offering every file to every asset, is not visible
at all.
