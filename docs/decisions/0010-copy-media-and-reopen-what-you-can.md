# ADR-10: Copy the media into storage, and reopen what you can

**Status:** Accepted

## Context

Reloading lost everything. Panel sizes survived in `localStorage`; the edit did
not, and `idb` sat in `package.json` unused.

The obvious first move — save the project's JSON and remember where the files
came from — does not work. A `File` is a handle the operating system handed us,
and after a reload nothing can get it back. A stored path is worth nothing,
because the web platform cannot reopen a file by path. The bytes have to be
copied somewhere we control.

## Decision

1. **Two stores in IndexedDB.** `projects` holds the edit; `blobs` holds the
   media, keyed `[projectId, assetId]`. A third, `meta`, remembers which project
   was open.
2. **Bytes are written once, at import, and never rewritten.** Only the edit is
   written on every change, debounced by 700 ms. That split is the whole reason
   autosave is affordable: a save is a few kilobytes of JSON, not a gigabyte of
   video.
3. **No content-hash deduplication.** Sharing one blob between projects would
   save space, but it needs reference counting, and a wrong reference count
   silently deletes somebody's footage. Per-project keys are boring and correct.
4. **Reopening never destroys the edit.** A project whose media is gone still
   opens: the clips stay, the missing assets are listed, and the user is told
   what to re-import.
5. **Re-probe on load, and trust the probe** over the stored metadata. A stale
   duration would disagree with the bytes silently, and the bytes are the truth.
6. **A migration chain from the start.** `project-format.ts` walks versions
   forward one step at a time. `v1` has no step and is refused, because its clip
   model was different and no honest conversion exists.

## Why

**Refusing to open a damaged project throws away the one irreplaceable part.**
Media can be re-imported; a mangled timeline cannot. Every refusal therefore
carries a message that says *the file is fine, only the app is behind* — so a
user with an old file updates instead of assuming their work is corrupt.

**The format is a long-lived contract with the user's files, and the storage is
not.** So they are separate modules: `project-format.ts` is pure and fully unit
tested, `persistence.ts` holds the IndexedDB details. When the storage changes,
the files do not.

**A silent autosave is the worst failure available for this feature.** The user
believes their work is safe and finds out at reload that none of it was. So the
save state is on screen at all times, a failure is loud, and `setMeta` reads back
what it wrote before trusting it.

## Consequences

- **A project costs roughly as much disk as its media.** Stated in
  [risks.md](../risks.md#r7--a-project-costs-as-much-disk-as-its-media), and
  `usage()` exists to show it. `navigator.storage.persisted()` is checked: a
  project in evictable storage can vanish under disk pressure.
- **Projects are tied to one browser profile.** Not portable, not shareable.
  Writing a real folder to disk is a separate feature and Chromium-only.
- `MediaLibrary.add()` takes an optional id, so a reopened project reuses its
  asset ids. Without it every clip would point at nothing while looking valid.
- `MediaLibrary.clear()` is separate from `dispose()`: one means "the project
  changed, this can be refilled", the other means "the app is shutting down".
- The whole project is written **key by key**, and the assets map is the one key
  that goes through `reconcile`. Written any other way, either a forgotten key
  is blanked or the new project inherits the old one's files.

## The project list

`⌘O`, or the save indicator in the top bar. It lists every project with its clip
count, media size and last save; offers New, Open, Rename, Duplicate and Delete;
and shows what the storage costs, because that is the bill for decision 1.

Two deliberate choices:

- **`beforeunload` is gated on the save state.** The browser's "leave site?"
  prompt is the most irritating thing an app can do, and it stops working the
  first time it appears for no reason — people learn to click through it.
  Autosave closes the window within 700 ms, so it should almost never appear,
  and the case that really matters is a save that is *failing*.
- **Delete asks twice.** It takes the media with it and there is no undo.

## Three bugs this decision shipped with

None were caught by the type checker, the unit tests, or the build. All three
only appeared when a saved project was actually reopened.

1. **The library is not reactive.** `MediaLibrary` is a plain `Map`, and the
   media bin's rows read it with `<Show when={state.entryFor(id)}>`, which
   evaluates once and never re-checks. Writing the project *before* rehydrating
   created the rows while the library was still empty, so they stayed invisible —
   a bin showing its populated branch with nothing in it, while the clip titles
   (which read the store) looked perfectly fine. Importing has always had the
   other order, so nothing noticed until a project was reopened.
2. **Solid merges object writes rather than replacing them.** After `open()` the
   asset keys were readable through the proxy, but `project.assets` was still the
   same object, so `<For each={Object.keys(project.assets)}>` never re-ran.
   `reconcile` does not help — it mutates in place too. There is now an explicit
   revision counter, and `assets.ts` reads it.
3. **A test that could not fail.** The first attempt to check the migration chain
   read a global that nothing ever set, and passed forever. It is now a real
   assertion over the exported table, and it fails when a step goes missing.

4. **`reconcile` is right on exactly one key.** Starting a new project left the
   old project's files in the media bin *and* wrote them into the new project,
   because Solid's plain object set **merges** — it can add keys and never remove
   them. A reconciler does delete, and that is now used for the assets map and
   nowhere else. It is safe there and unsafe everywhere else, which sounds
   contradictory but is exactly the rule: it is safe because that map is
   *complete*, and the historical disaster was reconciling a *partial* object.
5. **The library has to be cleared, not just replaced.** Its entries hold live
   `Input`s and `CanvasSink`s, so carrying them into another project leaks
   decoders and keeps the old files visible.
6. **The open project could not be renamed.** Its row swapped `Rename` for
   `Close`, so the one project you were working in was the one you could not
   name. Found by driving the panel, not by reading it.

### The harness lied about all three

`--virtual-time-budget` fast-forwards timers but starves IndexedDB's **write**
transactions, while reads still complete. So the first persistence probe
reported a working save and a completely broken reload, and two of the "bugs"
above were the harness. The fix was a real-time harness: a probe that POSTs its
results to a local sink, and no virtual clock. **A test that reports the opposite
of reality is worse than no test**, because it sends you to fix the wrong thing.
