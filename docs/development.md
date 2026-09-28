# Development

## Commands

```bash
npm run dev         # dev server, http://localhost:5173
npm test            # 9 suites — no browser, no network
npm run typecheck   # tsc --noEmit
npm run build       # typecheck + production build
```

`npm test` is a chain of individual `node --experimental-strip-types` runs rather
than a test-runner dependency. Each suite is a plain script with `node:assert`;
suites are listed explicitly in `package.json` so a failure names the file.

## Logging

`debug.ts` forwards browser logs to the dev-server terminal. The browser is
opened once and left alone.

```
http://localhost:5173/__debug        the log viewer
```

In-app, `log.debug/info/warn/error` writes to both the console and the ring
buffer. This exists because *"send me the console output"* is a terrible
debugging loop.

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

`state.ts` is being decomposed into cohesive slices that take their dependencies
as arguments and return an object — `app/selection.ts` and `app/history.ts` are
the two so far. The pattern:

- The slice owns its own signals, and nobody outside it writes to them.
- It takes the project as an argument to *read*, and explicit callbacks for the
  few things it must *do* (`createHistory` takes a `restore` and an `onRestore`
  rather than reaching for the store).
- `state.ts` re-exports under the names the UI already uses, so a new slice
  never forces a change to a component.

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
