# Refactor plan — `src/app/view`

**Status:** executed (Phases 0–4 landed; Phase 5 left as optional follow-up)
**Scope:** reorganise `src/app/view` into feature folders. No logic changes. No behaviour changes.
**Goal:** root of `view/` goes from 17 loose files to one (`App.tsx`), every helper lives with its owner or in a correct shared layer, and the structure scales when new panels/features arrive.

---

## 0. Goal and non-goals

### Goal
- Group files by **feature**, not by file extension.
- Make each feature folder self-contained (entry component + its private helpers + sub-components).
- Give truly shared code exactly two shared homes: `ui/` (feature-free primitives) and `shell/` (app chrome).
- Keep the diff mechanical and reviewable: **moves and import rewrites only**.

### Non-goals
- No renames of exported symbols, no API changes.
- No component rewrite, no styling change, no state change.
- No new abstractions "for cleanliness".
- Do **not** touch `timeline/` and `preview/` internals — only (optionally) move their entry component *in*.

---

## 1. The rule that decides every placement

> **Co-locate a file with its feature. Hoist only when two or more features use it — and then by kind, never into a single `shared/`.**

- A helper used by exactly one feature → that feature's folder.
- A helper used by 2+ features:
  - pure / presentational / feature-free → `ui/`
  - app chrome / layout → `shell/`
- A single `shared/` folder is **rejected**: it becomes a cycle magnet and a junk drawer, which is the exact problem this refactor is fixing.

### Why not a `types.ts` / `utils.ts` folder
A "folder of TypeScript files" makes coupling invisible: two unrelated features both reach into it, and you lose the ability to see what depends on what. Placement by owner is the whole point. `format.ts` is the only genuinely cross-cutting pure helper; it goes in `ui/`.

---

## 2. Target tree

```
src/app/view/
├── App.tsx                      # composition root — the only loose file
│
├── ui/                          # feature-free primitives, reused anywhere
│   ├── Modal.tsx                # (already here)
│   ├── Tooltip.tsx              # (already here)
│   ├── ContextMenu.tsx          # moved from root
│   └── format.ts                # moved from root
│
├── shell/                       # app chrome: layout, not a feature
│   ├── Resizer.tsx              # moved from root
│   ├── PanelToggle.tsx          # moved from root
│   └── fullscreen.ts            # moved from root
│
├── media/                       # media bin + review + file helpers
│   ├── AssetBin.tsx             # moved from root
│   ├── MediaPanel.tsx           # moved from root
│   ├── thumbnail.ts             # moved from root
│   └── folder.ts                # moved from root
│
├── projects/                    # project list + import/export text
│   ├── ProjectPanel.tsx         # moved from root
│   └── transfer.ts              # moved from root
│
├── logs/
│   └── LogPanel.tsx             # moved from root
│
├── shortcuts/
│   └── ShortcutsPanel.tsx       # moved from root
│
├── export/
│   └── ExportDialog.tsx         # moved from root
│
├── preview/                     # feature folder (entry moved in — see Phase 4)
│   ├── Preview.tsx              # moved from root
│   ├── Transport.tsx
│   ├── Scrubber.tsx
│   ├── paint-intent.ts
│   └── use-playback-clock.ts
│
└── timeline/                    # feature folder (entry moved in — see Phase 4)
    ├── Timeline.tsx             # moved from root
    ├── Lane.tsx
    ├── Clip.tsx
    ├── DropCue.tsx
    ├── Filmstrip.tsx
    ├── Ruler.tsx
    ├── ticks.ts
    ├── TimelineScrollbar.tsx
    ├── Toolbar.tsx
    ├── Waveform.tsx
    └── use-timeline-drag.ts
```

---

## 3. Move map (every file)

| # | Old path | New path | Kind |
|---|---|---|---|
| 1 | `src/app/view/App.tsx` | *(unchanged)* | composition root |
| 2 | `src/app/view/ContextMenu.tsx` | `ui/ContextMenu.tsx` | shared primitive |
| 3 | `src/app/view/format.ts` | `ui/format.ts` | shared pure helper |
| 4 | `src/app/view/Resizer.tsx` | `shell/Resizer.tsx` | shared chrome |
| 5 | `src/app/view/PanelToggle.tsx` | `shell/PanelToggle.tsx` | shared chrome |
| 6 | `src/app/view/fullscreen.ts` | `shell/fullscreen.ts` | shared chrome |
| 7 | `src/app/view/AssetBin.tsx` | `media/AssetBin.tsx` | media feature |
| 8 | `src/app/view/MediaPanel.tsx` | `media/MediaPanel.tsx` | media feature |
| 9 | `src/app/view/thumbnail.ts` | `media/thumbnail.ts` | media feature |
| 10 | `src/app/view/folder.ts` | `media/folder.ts` | media feature |
| 11 | `src/app/view/ProjectPanel.tsx` | `projects/ProjectPanel.tsx` | projects feature |
| 12 | `src/app/view/transfer.ts` | `projects/transfer.ts` | projects feature |
| 13 | `src/app/view/LogPanel.tsx` | `logs/LogPanel.tsx` | logs feature |
| 14 | `src/app/view/ShortcutsPanel.tsx` | `shortcuts/ShortcutsPanel.tsx` | shortcuts feature |
| 15 | `src/app/view/ExportDialog.tsx` | `export/ExportDialog.tsx` | export feature |
| 16 | `src/app/view/Preview.tsx` | `preview/Preview.tsx` | preview feature (Phase 4) |
| 17 | `src/app/view/Timeline.tsx` | `timeline/Timeline.tsx` | timeline feature (Phase 4) |
| 18 | `src/app/view/ui/Modal.tsx` | *(unchanged)* | shared primitive |
| 19 | `src/app/view/ui/Tooltip.tsx` | *(unchanged)* | shared primitive |
| 20 | `src/app/view/preview/*` | *(unchanged internals)* | preview feature |
| 21 | `src/app/view/timeline/*` | *(unchanged internals)* | timeline feature |

**Rename only in a later, separate pass** (Phase 5). Keeping filenames on the move commit makes a bad move trivial to bisect.

---

## 4. Where the `.ts` helpers go

| Helper | Consumers | New home | Reason |
|---|---|---|---|
| `thumbnail.ts` | `media/AssetBin.tsx`, `timeline/Filmstrip.tsx` | `media/thumbnail.ts` | Media concern. Timeline *consumes* media; a cross-feature import of a data helper is fine. |
| `folder.ts` | `media/MediaPanel.tsx` | `media/folder.ts` | One owner → co-locate. |
| `transfer.ts` | `App.tsx`, `projects/ProjectPanel.tsx` | `projects/transfer.ts` | Project import/export belongs to the projects feature. |
| `fullscreen.ts` | `App.tsx`, `preview/Preview.tsx`, `commands/menu-items.ts`, `commands/shortcuts.ts` | `shell/fullscreen.ts` | App chrome; headless. Cross-boundary (commands) import is already the status quo. |
| `format.ts` | `App.tsx`, `preview/Transport.tsx` | `ui/format.ts` | Genuinely cross-cutting, pure, feature-free. |

`use-playback-clock.ts` and `paint-intent.ts` already live in `preview/` and are correct there.

---

## 5. Import rewrites

### 5.1 The mechanical rule
Every moved file changes its **relative import depth**, so imports must be rewritten, not just the moved file's own path. Examples:

- Moving `ContextMenu.tsx` → `ui/ContextMenu.tsx`: unchanged depth for its own imports (`../../dev/debug.js` stays `../../dev/debug.js`). Its **importers** change.
- Moving `Timeline.tsx` → `timeline/Timeline.tsx`: it goes one level deeper, so:
  - `../store/state.js` → `../../store/state.js`
  - `../../model/project.js` → `../../../model/project.js`
  - `./ContextMenu.js` → `../ui/ContextMenu.js`
  - `./AssetBin.js` → `../media/AssetBin.js`
  - `./timeline/Lane.js` → `./Lane.js`
  - `./timeline/TimelineScrollbar.js` → `./TimelineScrollbar.js`, etc.
- Moving `Preview.tsx` → `preview/Preview.tsx`: same one-level shift (`./preview/Transport.js` → `./Transport.js`, `../store/state.js` → `../../store/state.js`, etc.).

**Do not hand-audit these.** The specifiers are explicit `.js` paths, so `npm run typecheck` fails on every stale one. Use it as the mechanical proof.

### 5.2 Importers outside `view/` that must change
These live in `src/app/commands/` and already reach into `view/`:

| File | Old import | New import |
|---|---|---|
| `src/app/commands/menu-items.ts` | `../view/ContextMenu.js` | `../view/ui/ContextMenu.js` |
| `src/app/commands/menu-items.ts` | `../view/fullscreen.js` | `../view/shell/fullscreen.js` |
| `src/app/commands/shortcuts.ts` | `../view/ContextMenu.js` | `../view/ui/ContextMenu.js` |
| `src/app/commands/shortcuts.ts` | `../view/fullscreen.js` | `../view/shell/fullscreen.js` |

(Verify the exact spellings with `grep -rn "view/" src/app/commands`.)

### 5.3 `App.tsx` import block after the move
```
./ui/ContextMenu.js
./ui/format.js
./shell/Resizer.js
./shell/fullscreen.js
./media/AssetBin.js
./media/MediaPanel.js
./projects/ProjectPanel.js
./projects/transfer.js
./logs/LogPanel.js
./shortcuts/ShortcutsPanel.js
./export/ExportDialog.js
./preview/Preview.js
./timeline/Timeline.js
```

### 5.4 Cross-feature coupling to keep an eye on
`timeline/Timeline.tsx` and `timeline/Lane.tsx` import `DND_ASSET` / `draggedAssetId` from `AssetBin.tsx`. After the move that becomes `timeline → media`. That is a data contract, not UI, so the clean fix is a later extraction:

> **Optional Phase 5:** move `DND_ASSET` and `draggedAssetId` into `media/dnd.ts` so the timeline depends on a payload contract rather than a component module.

---

## 6. Test updates

Structural tests read source files by **exact path**, so every move breaks them unless updated. There are 37 references in `test/dom.test.ts` alone, plus several component tests.

### 6.1 Files that need path updates
| Test file | Change |
|---|---|
| `test/dom.test.ts` | many — see §6.2 |
| `test/folder.test.ts` | `src/app/view/folder.ts` → `src/app/view/media/folder.ts` |
| `test/components/asset-bin.test.tsx` | `AssetBin.js` → `media/AssetBin.js`; `ContextMenu.js` → `ui/ContextMenu.js` |
| `test/components/context-menu.test.tsx` | `ContextMenu.js` → `ui/ContextMenu.js` |
| `test/components/resizer.test.tsx` | `Resizer.js` → `shell/Resizer.js` |

### 6.2 `test/dom.test.ts` exact references to update
By line (current file):

| Line(s) | Old path | New path |
|---|---|---|
| 66 | `../src/app/view/AssetBin.tsx` | `../src/app/view/media/AssetBin.tsx` |
| 177 | `../src/app/view/App.tsx` | *(unchanged)* |
| 203 | `../src/app/view/AssetBin.tsx` | `media/AssetBin.tsx` |
| 203 | `../src/app/view/Preview.tsx` | `preview/Preview.tsx` |
| 228 | `../src/app/view/timeline/use-timeline-drag.ts` | *(unchanged)* |
| 229 | `../src/app/view/Timeline.tsx` | `timeline/Timeline.tsx` |
| 362, 403, 433, 484, 568, 639 | `../src/app/view/timeline/use-timeline-drag.ts` | *(unchanged)* |
| 519 | `../src/app/view/Timeline.tsx` | `timeline/Timeline.tsx` |
| 642–644 | `timeline/Clip.tsx`, `timeline/Lane.tsx`, `Timeline.tsx` | Clip/Lane unchanged; `Timeline.tsx` → `timeline/Timeline.tsx` |
| 812–819 | `App.tsx`, `preview/Transport.tsx`, `AssetBin.tsx`, `timeline/Toolbar.tsx` | AssetBin → `media/AssetBin.tsx`; rest unchanged |
| 852 | `fullscreen.ts` | `shell/fullscreen.ts` |
| 885 | `Preview.tsx` | `preview/Preview.tsx` |
| 937–938 | `Resizer.tsx`, `App.tsx` | Resizer → `shell/Resizer.tsx`; App unchanged |
| 977–978 | `Preview.tsx`, `App.tsx` | Preview → `preview/Preview.tsx` |
| 1015 | `preview/paint-intent.ts` | *(unchanged)* |
| 1094–1096 | `Timeline.tsx`, `timeline/Lane.tsx`, `timeline/DropCue.tsx` | Timeline → `timeline/Timeline.tsx`; rest unchanged |
| 1121 | `timeline/Ruler.tsx` | *(unchanged)* |
| 1209–1214 | `App.tsx`, `ProjectPanel.tsx`, `MediaPanel.tsx`, `transfer.ts` | ProjectPanel → `projects/ProjectPanel.tsx`; MediaPanel → `media/MediaPanel.tsx`; transfer → `projects/transfer.ts` |
| 1239 | `folder.ts` | `media/folder.ts` |
| 1393, 1395 | `App.tsx`, `transfer.ts` | transfer → `projects/transfer.ts` |

**Recommended pre-step (Phase 0):** centralise these into one map, e.g.

```ts
// test/view-paths.ts
export const VIEW = {
  app: 'src/app/view/App.tsx',
  assetBin: 'src/app/view/media/AssetBin.tsx',
  mediaPanel: 'src/app/view/media/MediaPanel.tsx',
  contextMenu: 'src/app/view/ui/ContextMenu.tsx',
  fullscreen: 'src/app/view/shell/fullscreen.ts',
  resizer: 'src/app/view/shell/Resizer.tsx',
  transfer: 'src/app/view/projects/transfer.ts',
  folder: 'src/app/view/media/folder.ts',
  preview: 'src/app/view/preview/Preview.tsx',
  timeline: 'src/app/view/timeline/Timeline.tsx',
  drag: 'src/app/view/timeline/use-timeline-drag.ts',
  // …
} as const
```

Then `dom.test.ts` reads `VIEW.assetBin`, and any future move touches **one file**. This is the single highest-leverage change in the whole plan.

### 6.3 Tests that do **not** change
`test/snapping.test.ts`, `test/timeline.test.ts` (they reference `timeline/use-timeline-drag.ts`, `timeline/ticks.ts`, which stay); `test/paint-intent.test.ts`; `test/components/lane-split.test.tsx`, `timeline-drag.test.tsx`, `modal.test.tsx`, `scrubber.test.tsx` (all point at stable paths).

---

## 7. Migration order

Phases 0–4 below were executed. Each phase ended **green** (`typecheck` + `test`, plus `build` at the end) before the next started. One phase per commit.

One deviation from the plan as written: Phase 4 also had to update five `src/app/view/Preview.tsx:<line>` citations in `docs/reading-order.md` and `docs/traces/02-playback.md`. A `dom.test.ts` guard asserts that every `path:line` cited in the docs exists and is not blank, so moving a cited file breaks the docs even when the code is untouched. The cited lines were verified byte-identical before and after the move, so only the paths needed changing.

| Phase | Work | Risk |
|---|---|---|
| **0** | Add `test/view-paths.ts`; replace literal paths in `dom.test.ts`, `folder.test.ts`, and the component tests with the map. No source moves. | Low, and it de-risks every later phase. |
| **1** | Create `ui/` and `shell/`. Move `ContextMenu.tsx`, `format.ts` → `ui/`; `Resizer.tsx`, `PanelToggle.tsx`, `fullscreen.ts` → `shell/`. Update all importers (incl. `src/app/commands/*`). | Low–medium (commands import `fullscreen`/`ContextMenu`). |
| **2** | Create `media/` and `projects/`. Move `AssetBin`, `MediaPanel`, `thumbnail`, `folder`; `ProjectPanel`, `transfer`. Update importers (`App`, `timeline/Filmstrip`, `timeline/Lane`, `timeline/Toolbar`, `timeline/Timeline`). | Medium (cross-feature imports). |
| **3** | Create `logs/`, `shortcuts/`, `export/`. Move `LogPanel`, `ShortcutsPanel`, `ExportDialog`. Update `App`. | Low. |
| **4** | Move `Preview.tsx` → `preview/Preview.tsx`, `Timeline.tsx` → `timeline/Timeline.tsx`. Update `App`, `test/view-paths.ts`, and the docs citations. | Medium (deeper path shift). |
| **5** *(optional, not done)* | Rename files for clarity (`AssetBin`→`MediaBin`, `MediaPanel`→`MediaReview`, `ProjectPanel`→`ProjectList`). Extract `DND_ASSET`/`draggedAssetId` into `media/dnd.ts`. | Low, pure churn; do last. |

**Per-phase recipe:**
1. `git mv` the files (preserves history).
2. Fix specifiers in the moved files and every importer until `npm run typecheck` is clean.
3. Update `test/view-paths.ts` (and only it, if Phase 0 landed).
4. `npm test` + `npm run build`.
5. `grep -rn "app/view/" src test` and confirm nothing points at a deleted path.

### Tooling worth keeping

Depth changes are arithmetic, not judgement calls. `git mv` plus a specifier rebase (resolve each `'./x'` against the old directory, re-relativise against the new one) is safer than hand-editing: for `Timeline.tsx` it rewrote all 11 specifiers correctly, including `./timeline/Lane.js` → `./Lane.js` and `./ui/ContextMenu.js` → `../ui/ContextMenu.js`. Verify with `tsc` — the specifiers are explicit `.js` paths, so a stale one is a compile error, not a runtime surprise.

---

## 8. Verification checklist

- [ ] `npm run typecheck` — the mechanical proof that no `.js` specifier is stale.
- [ ] `npm test` — 303 logic + 16 component tests green.
- [ ] `npm run build` — production build clean.
- [ ] `grep -rn "app/view/" src test` returns only paths that exist.
- [ ] `git diff --stat -M` shows the moved files as **renames**, not delete+add.
- [ ] Manual smoke test in the browser: import a file → drag from the bin to a lane → move a clip → split (`S`) → trim a handle → export. Confirms the composition root still wires everything.
- [ ] No change in bundle entry (`src/main.tsx`) — `App` path is unchanged.

---

## 9. Risks and rollback

| Risk | Likelihood | Mitigation |
|---|---|---|
| Structural test strings go stale | High | Phase 0 path map; update one file per move. |
| Missed `.js` specifier | Medium | `tsc` catches all of them; run per phase. |
| `commands/*` → `view/*` imports missed | Medium | §5.2; `grep -rn "view/" src/app/commands`. |
| `timeline` → `media/AssetBin` coupling made uglier | Low | Acceptable; optional `media/dnd.ts` extraction in Phase 5. |
| HMR/dev breakage mid-refactor | Low | Each phase is a complete, green commit; `git revert` is safe. |
| Deeper paths slow typecheck slightly | Negligible | — |

**Rollback:** every phase is an isolated commit of `git mv` + specifier edits; revert the commit. No runtime state or data format is touched.

---

## 10. Open decisions

Both questions below were resolved in favour of the recommendation when the phases ran; they are recorded so the reasoning survives.

1. **Move `Preview.tsx` / `Timeline.tsx` into their feature folders (Phase 4)?**
   - *Yes* → fully consistent (feature folder contains its entry), at the cost of updating more test paths and the docs citations.
   - *No* → smaller diff, but the root keeps two loose entry files and the "feature folder" is really "helpers folder".
   - **Decided: yes.** Done in Phase 4.
2. **Rename `AssetBin` → `MediaBin`, `MediaPanel` → `MediaReview`, `ProjectPanel` → `ProjectList`?**
   - Recommendation: defer to Phase 5. Moving and renaming at once makes review and bisection harder.
3. **`format.ts` in `ui/` or a dedicated `lib/`?**
   - Recommendation: `ui/` for now. Introduce `lib/` only if pure non-UI helpers accumulate beyond one file.
4. **Group all modal screens under `overlays/` instead of one-file feature folders?**
   - Only matters if `logs/`, `shortcuts/`, `export/` stay single-file forever. If they grow, feature folders win. Default: keep separate feature folders.

---

## 11. One-line summary

Move shared primitives to `ui/`/`shell/`, group the panels and their helpers into `media/`, `projects/`, `logs/`, `shortcuts/`, `export/`, fold the `Preview`/`Timeline` entry files into their existing feature folders, and land it as mechanical, per-phase `git mv` commits with a centralised test path map so no move can silently break the structural tests.
