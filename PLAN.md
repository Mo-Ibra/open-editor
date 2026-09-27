# open-editor — Project Plan

> A fast, local-first video editor for creators. No account, no upload, no server.
> Render on the user's machine. Drop a clip, cut it, zoom it, add a caption, export.
> **Runs in a browser tab. Nothing to install.**

**Status:** planning. Nothing built yet.
**Written:** 2026-09-27
**Revised:** 2026-09-28 — switched from Electron desktop to web-first. See §4 ADRs 2, 5, 7, 8.
**Starting point:** `github.com/diffusionstudio/editor` @ `0.206.0` (MPL-2.0) — used as a *design and code reference*, not a fork.

---

## 1. TL;DR

| Decision | Answer |
|---|---|
| What is it? | Local-first video editor, YouTuber/screencaster audience, "fast" as the primary feature |
| Shape | **A web app.** PWA, static host, no backend, no install |
| Where does the code come from? | New repo. Copy `packages/runtime`, `packages/encoder`, `packages/assets` from diffusionstudio (MPL-2.0, keep headers). Rewrite everything above them |
| Renderer | **Canvas 2D + WebCodecs** for both preview and export. One renderer. WYSIWYG guaranteed |
| FFmpeg | **Ingest fallback only, via `ffmpeg.wasm`, lazy-loaded.** Never compositing. LGPL build or it doesn't ship |
| Project format | Flat JSON → `buildWorld(json) → world`. No compiler, no JSX, no AST write-back |
| Shell | **None.** Vite + SolidJS. Electron is dropped. Tauri later, only if users demand it |
| Media storage | File System Access handles (Chromium) → IndexedDB fallback. Never uploaded |
| Host | Static. Cloudflare / Netlify. COOP + COEP headers |
| License | Open source, MPL-2.0 core. Closed/cloud product on top is permitted |
| Business model | Open core. Free local editor. Paid cloud tier for the things local *cannot* do |
| MVP | 7 features. Everything else is out. See §8 |

---

## 2. The product

### Who it's for
YouTubers, streamers, course creators, anyone cutting video today in Premiere / Resolve / CapCut and hating it.

### The promise
**Drop a file. Cut it. Export.** Everything else is optional.

The competitive wedge is not features — it's the *absence* of friction. CapCut is free but cloud-shaped and bloated. Adobe is powerful and hostile. Resolve is free and overwhelming. Every one of them makes you fill in a project, choose a codec, or wait on a render farm.

A browser app is *less* friction, not more. A link beats a 150 MB installer. This is the Figma / Canva shape, and it is a deliberate choice — see ADR-5.

### Non-negotiables
1. **No account, ever.** Not a trial, not a soft wall, not an email gate.
2. **Nothing leaves the device.** No upload, no server-side processing, no "import to cloud". We do not have the bytes and we do not want them.
3. **Preview == export.** The same pixels you see are the pixels you get. No surprises.
4. **Every action is instant.** Drop → playable. Split → done. Export → progress bar and an honest ETA.
5. **No compiler.** The project is data, not source code.
6. **No install.** It runs in the tab. A PWA install is offered, never required.

### Explicitly *not* trying to be
An Adobe replacement. A motion-graphics tool. A plugin host. A collaborative editor (in the OSS version).

### The honesty problem, stated up front
Non-negotiable #2 used to read "files stay on the user's disk, no copy." A browser cannot always honour that. Chromium can hold a live disk handle and never copy a byte. Firefox and Safari cannot, so there the media is *copied into browser storage*. The promise we can keep everywhere is **"we never send your file anywhere"** — which is weaker and still true. Do not quietly imply the stronger one. See ADR-7 and R6.

---

## 3. Starting point: what diffusionstudio already gets right

Full audit of `diffusionstudio/editor` @ `0.206.0`. The key finding: **the entire video pipeline is already 100% local, and already browser-native.** No ffmpeg, no server, no upload anywhere in the render path. The majority of this repo is a *web* app, which is what made the switch in ADR-5 cheap.

### The pipeline is local

```
decode (mediabunny/WebCodecs)
  → composite (Canvas 2D)
  → motion/keyframe evaluation
  → encode (WebCodecs VideoEncoder/AudioEncoder)
  → mux (mediabunny: mp4/webm/mov/ogg)
  → download / write file
```

- Compositing: Canvas 2D, `packages/runtime/src/systems/render.ts` (916 lines)
- Encode: `packages/encoder/src/encoder.ts` — `mediabunny` + WebCodecs
- Audio mix: `OfflineAudioContext` + `GainNode` graph + `AudioWorklet`
- **Preview and export run the identical motion code** — the encoder calls `motionSystem(world)` (`encoder.ts:284`), the same function the live preview calls. This is the single most important architectural decision in the codebase and the reason the export can be trusted.

### Features that already exist and map to the MVP

| MVP feature | Where it lives | State |
|---|---|---|
| Zoom / scale | `Scale` trait, `packages/runtime/src/traits/transform.ts` | Done |
| Keyframes | `KeyframeTrack` + `Keyframe` as entities, `traits/motion.ts` | Done |
| 21 animatable props | `systems/motion.ts:258-362` (`getPropertyPaths`) | Done |
| Built-in animations | 14 presets, `systems/motion.ts:72-188` — fade, grow, shrink, blur, slide×4, spin, twist, gain, appear-word/char, scramble | Done |
| Easing | steps / cubic-bezier / spring via `animejs` 4.5 | Done |
| Captions / subtitles | 7 presets, `runtime/src/media/caption/*` (1,268 lines) — works offline from `.srt`/`.vtt` | Done |
| Text titles | Full pipeline, `runtime/src/utils/text.ts` (709 lines) | Done |
| Trim / split | `Trim`, `Delay`, `PlaybackRate`, `<sequence>` | Done |
| Transitions | 5 types, sequence-only | Done |
| Audio mixer | Gain tree, per-clip + per-scene, mute/solo/volume, `GAIN` keyframes | Done |
| Waveforms | Worker-based peaks, cached to disk | Done |
| Audio auto-sync | RMS envelope + cross-correlation, `media/audio-sync.ts` (233 lines) | Done |
| Speed change (audio) | Hand-written WSOLA stretcher, `media/time-stretcher.ts` (260 lines) | Done |
| Export | mp4 / webm / mov / ogg; avc, hevc, vp9, av1; up to 4K, 60fps | Done |
| Export presets | 9 templates incl. YouTube Shorts, TikTok, IG Reels | Done |
| Probe / thumbnails / filmstrips | `packages/assets` | Done |
| Atomic writes | temp + rename, `apps/desktop/src/atomic.ts` | **Not applicable in a browser.** No atomic rename exists. See R6 |

**The MVP is ~85% already built.** The work is in the product layer, not the engine. One caveat: "speed change" above is *constant* rate. Speed *ramps* are net-new — see Phase 5.

### Server coupling to delete

| Thing | Where |
|---|---|
| Supabase auth + realtime | `apps/web/src/context/auth.tsx`, `lib/supabase.ts` |
| tRPC client | `lib/trpc.ts` |
| Stripe checkout | `lib/checkout.ts` |
| GCS uploads | `lib/uploads.ts` |
| Umami analytics (web + main) | `lib/analytics.ts`, `apps/desktop/src/analytics.ts` |
| Sentry (hardcoded DSN, `sendDefaultPpi: true`) | `apps/web/src/index.tsx` |
| AI generation subsystem | `apps/web/src/utils/gen-ai.ts` (599 lines), `components/genai/` (2,584 lines) |
| Upgrade / billing / account UI | `components/upgrade-dialog.tsx`, `components/dashboard/*` |
| MCP server + CLI + tool catalog | `apps/desktop/src/dapi/*`, `apps/cli/*`, `packages/dapi` |
| In-app agent chat | `packages/agent-chat`, `apps/web/src/agent-chat/` |
| Update checks | `update-electron-app` polling GitHub releases — obsolete, a PWA updates itself |

### Things that must be replaced or deleted

| Thing | Why |
|---|---|
| **Project = folder of `.tsx` files** | The document *is* source code. Fatal for a non-programmer audience |
| **`apps/desktop/src/edit.ts` (1,182 lines of ts-morph)** | Every UI edit is an AST rewrite. Delete entirely |
| **`packages/reconciler` (2,496 lines)** | Compiles JSX → ECS. Replaced by `buildWorld(json)` |
| **Inspector UI (10,609 lines)** | Way too much for "no headache". `interpolation.tsx` alone is 988 lines |
| **9 effect types, 16 blend modes, masks, gradients, WebGPU shaders, `<html>`, three.js surfaces** | Differentiators against nothing. Cut for v1 |
| **Remote `WebFonts`** | `runtime/src/fonts/fixtures.ts` fetches from `fonts.gstatic.com` + S3 **at render time**. A hidden network dependency in an "offline" app. Bundle locally |
| **The whole `apps/desktop` tree** | Main process, IPC, preload bridge, native dialogs. Dead weight in a web build |
| **Disk-hash / filesystem-watching asset pipeline** | `packages/assets` assumes files on a disk. Re-key on a storage handle or blob id |

### Sizes, for planning

| Area | Lines |
|---|---|
| `packages/runtime/src` | 14,657 |
| `packages/assets/src` | 2,153 |
| `packages/reconciler/src` | 2,496 ← delete |
| `packages/encoder/src` | 1,092 |
| Inspector UI | 10,609 ← mostly delete |
| `apps/desktop/src/edit.ts` | 1,182 ← delete |
| `apps/desktop/src/*` (rest) | ~4,000 ← delete, no longer needed |

**Test coverage: there are ZERO tests for `runtime`, `encoder`, or `assets`.** All 20 test files are in `apps/desktop` (main process), `packages/dapi`, and `packages/agent-chat` — i.e. mostly in code you are deleting. The media core — the A/V sync, the encoder, the compositor — is entirely untested. If you vendor it, you inherit that. See §11 R3.

---

## 4. Architecture decisions

### ADR-1: One renderer, Canvas 2D + WebCodecs

**Decision.** Preview and export both use Canvas 2D compositing and WebCodecs encoding, driven by the same motion system.

**Why.** The alternative — building the compositor on FFmpeg — forces reimplementing, from scratch:
- Text layout *and* rasterization. The code depends on `fontBoundingBoxAscent/Descent` (a fragile member) for line breaking. FFmpeg's `drawtext` cannot do shadows, gradients, letter-spacing, or blend modes.
- All 9 CSS filters (`ctx.filter`)
- All 16 blend modes (`globalCompositeOperation`)
- All 7 caption styles

`render.ts` is 916 lines and **all 28 functions are Canvas2D calls** — there is no abstraction layer under any of it. Moving to FFmpeg means building a Canvas2D text engine inside an FFmpeg project. That is months of work, and it destroys precisely the features (zoom, titles, captions) that justify open-editor existing.

**Consequence.** WYSIWYG is structural, not aspirational. There is no second renderer to drift.

*Unchanged by the web switch — this is the keystone and it was already browser-native.*

### ADR-2: FFmpeg at ingest only, via WASM, lazy-loaded

**Decision.** ~~FFmpeg as a separate spawned process.~~ **Revised for web:** FFmpeg is `ffmpeg.wasm`, and it is **not loaded at all** until an import fails `canDecode()`. It never composites.

**Why.** A YouTuber's camera card is full of ProRes, DNxHD, 10-bit HEVC, and AC-3 audio. **Chromium cannot decode most of that.** mediabunny is a WebCodecs wrapper and inherits those limits exactly. Without a fallback, the first real user drops a ProRes `.mov` and the project is dead.

**How.**
1. At import, call `videoTrack.canDecode()`. If true — the common case, ~95% of files — nothing else happens. No WASM, no download.
2. If false, `mediabunny` already tells you *why*, via `Conversion`'s `discardedTracks[].reason === 'undecodable_source_codec'`. The original code throws that away (`transcode.ts:71-74`).
3. Only then: prompt the user ("this format needs a one-time 30 MB decoder download"), fetch `ffmpeg.wasm`, transcode to a browser-decodable intermediate in `cache/`, remember the result so it happens once per file.

**Cost.** ffmpeg.wasm is ~30 MB, runs in a worker, and is single-threaded unless you get the multithreaded build — which requires `SharedArrayBuffer`, which requires COOP/COEP headers, which ADR-8 already requires. Good news for once.

**Scope note.** We only need **decoders**. H.264 encoding already goes through WebCodecs.

**⚠️ This is now a licensing landmine, not just a technical one.** See §12. The stock `@ffmpeg/core` builds ship **GPL** components. Verify the exact build flags or do not ship this.

**Fallback if no LGPL WASM build exists.** Gate the product to web-decodable formats and say so honestly, rather than shipping a GPL binary. That guts the "drop anything" headline — which is why §14 makes this a Phase 0 question, not a Phase 2 task.

### ADR-3: Flat JSON project, no compiler

**Decision.** A project is `project.json` + a `cache/` of derived data. One function, `buildWorld(project) → World`, materializes the ECS world.

**Why.** The current design treats JSX source as the document and rewrites the AST on every edit. That is excellent for developers and unusable for creators. It also means: no compile step on open, no syntax errors to explain, no "the code broke", and autosave is free.

**The key adapter.** Replace `mount(code, world)` at `apps/web/src/engine/capture.ts:144` with `buildWorld(project)`. That single seam is what lets you delete the reconciler, the ts-morph write-back, and the compiler — a few hundred lines of new code to remove ~5,000.

**Bonus.** `packages/runtime/src/world/serialize.ts` already provides a full plain-JSON round trip (`EntityRecord`, ~60 optional primitive fields). It is explicitly labelled "not a persisted format" — but it proves every entity is serializable. Leverage it for undo/redo and copy/paste.

**Consequence for a web app.** The project file is now something the user *downloads and re-uploads*, not something sitting in a folder. Losing a 40 MB `project.json` because a tab was closed is a real failure mode. See R6.

### ADR-4: Keyframes as data, not a parallel system

**Decision.** A keyframe is `{ prop, time, value, easing }` in JSON. Interpolated by one function shared by preview and export.

**Why.** Keeping keyframes as ordinary entities in the current code is a good idea — they are copyable, inspectable, and write-back-able for free. In JSON they are just records. Do not build a second animation system alongside the transform system; that is where NLEs get slow.

21 animatable properties already exist (`systems/motion.ts:258-362`). **For v1 you only need `scale`, `position`, and `opacity`.** Ship the rest later.

### ADR-5: Web-first, no desktop shell

**Decision.** ~~Electron.~~ **Revised:** Ship as a PWA on a static host. No Electron, no Tauri, no native shell at launch.

**Why web.** The product promise is *drop, cut, export*. A URL is strictly lower friction than a download-and-install, and the audience is people who already resent installers. It also deletes an entire category of work: code signing, notarization (§14, now moot), auto-update, platform builds, and a crash-reporting service you didn't want. And critically — the source material is *already a web app*, so this is a packaging decision, not a port.

**Why not Electron.** You no longer need native file dialogs (File System Access API), nor filesystem watching, nor a preload bridge, nor atomic writes. You trade those for reach. Given that the engine is unchanged, that trade is worth it.

**Why not PWA-only-without-a-shell-forever.** It isn't. Power users editing 4K ProRes on a 16 GB laptop will hit the storage and codec walls (R2, R6). If that demand is real, ship a thin **Tauri** wrapper later. Because the entire app is a web app, that is a packaging change measured in days, not a rewrite. Do not build it speculatively.

**Cost.** You lose the guaranteed-`SharedArrayBuffer` of a desktop app, the real filesystem, and any hope of atomic writes. ADR-7 and R6 address this. You also inherit browser differences — see R2 and R7.

### ADR-6: No scripting escape hatch in v1

**Decision.** No custom JSX, no user-authored animation code, no plugin API in v1.

**Why.** Every escape hatch re-introduces the compiler and the write-back layer. If you later want a scripting hook, expose it as **JSON animation presets**, not code. Ship the closed tool first; a community that has 100 real projects will tell you what the hook needs to be.

### ADR-7: Two-tier media storage

**Decision.** Media is referenced, not embedded. Each asset records *how to get its bytes*:

| Tier | Mechanism | Guarantee | Browsers |
|---|---|---|---|
| **Primary** | File System Access `FileSystemHandle`, stored in IndexedDB | Bytes stay on disk, never copied, re-openable across sessions | Chromium only |
| **Fallback** | `Blob` in IndexedDB | Bytes copied into browser storage | Everywhere |

**Why this is the shape.** The strong version of the promise — "your files are still on your disk" — is only available in Chromium. The weak version — "we never send your file anywhere" — is available everywhere. Ship both, prefer the strong one, and **label which one the user is getting.**

**Rules.**
- Never upload. There is no upload path in the codebase, and it should stay that way.
- On a disk handle, media is re-read on demand — no memory ceiling.
- On a blob, respect the quota. Report usage (`navigator.storage.estimate()`) in the UI. Warn before a multi-GB import.
- Persist handles so reopening a project in Chromium is instant.
- A missing or revoked handle must produce a clear, actionable error, never a silent black clip.

**Why not OPFS.** Origin Private File System is the other option and it is a genuinely good one for the cache. Use it for `cache/` and intermediates. Do not put user *source media* there — it is quota-bound and opaque to the user.

### ADR-8: Static host, no backend

**Decision.** The entire application ships as static assets. No server, no API, no database, no auth provider.

**Why.** This is what makes non-negotiables #1 and #2 structurally true rather than aspirational. There is nowhere for a file to go.

**Consequences to accept up front.**
- **COOP + COEP headers are mandatory** on the host. Required for `SharedArrayBuffer` → the audio back-pressure loop in `encoder.ts`, and for threaded ffmpeg.wasm. Configure on Cloudflare / Netlify and verify in CI.
- All assets need cache-busting hashes and a real CDN.
- No telemetry, by choice. If you want error reporting, it is opt-in and PII-free (Phase 6).

---

## 5. Repo skeleton

```
open-editor/
├── packages/
│   ├── runtime/          ← copied from diffusionstudio (MPL headers kept)
│   ├── encoder/          ← copied
│   ├── assets/           ← copied, storage layer re-keyed (ADR-7)
│   ├── project/          ← NEW. JSON schema + buildWorld() + history
│   │   ├── schema.ts          zod schema for project.json
│   │   ├── build-world.ts     JSON → ECS world  (the adapter)
│   │   ├── history.ts         undo/redo
│   │   └── migrate.ts         schema versioning
│   └── storage/          ← NEW. ADR-7
│       ├── handles.ts         File System Access + IndexedDB fallback
│       ├── opfs.ts            cache/ intermediates
│       └── quota.ts           storage.estimate() reporting
├── apps/
│   └── web/              ← SolidJS. The whole product
│       ├── index.html
│       ├── vite.config.ts     COOP/COEP headers
│       ├── public/sw.js       PWA service worker
│       └── src/components/
│           ├── timeline/       keep, simplify
│           ├── canvas/         keep
│           ├── inspector/      REWRITE. ~5 controls, not 10,609 lines
│           ├── soundboard/     keep mixer, add library
│           └── library/        asset browser
├── media/
│   └── sfx/              ← bundled sound effects (WAV, git-lfs or CDN)
├── licenses/
│   └── FFMPEG.md         ← REQUIRED. Exact wasm build flags, or do not ship (ADR-2)
├── patches/
│   └── koota+0.6.6.patch  ← REQUIRED. koota is patched; nothing compiles without it
└── LICENSE               ← MPL-2.0
```

### Immediately deletable from the copied code

`packages/reconciler` · `packages/jsx` (generate API) · `packages/dapi` · `packages/agent-chat` · `apps/cli` · **all of `apps/desktop`** · all of `components/genai/` · all of `components/dashboard/` · `lib/{supabase,trpc,checkout,uploads,analytics}.ts` · `utils/gen-ai.ts` · `update-electron-app`

### Stack

| Package | Version | License | Note |
|---|---|---|---|
| `mediabunny` | 1.50.6 | MPL-2.0 | Demux, mux, WebCodecs, probe, transmux |
| `solid-js` | 1.9.14 | MIT | UI |
| `koota` | 0.6.6 | ISC | **Patched.** See §11 |
| `animejs` | 4.5.0 | MIT | Keyframe easing |
| `zod` | 4.x | MIT | Project schema validation |
| `kobalte` | 0.13.x | MIT | Headless UI |
| `idb` | 8.x | ISC | Handles + blobs + project registry |
| `@ffmpeg/ffmpeg` | pin exactly | **verify** | Lazy. See ADR-2 and §12 |
| `vite` | latest | MIT | Build |
| `yaml` | 2.9 | ISC | Keep for asset manifest, or switch to JSON |

Drop: `@supabase/supabase-js`, `@trpc/*`, `@sentry/solid`, `dompurify`, `marked`, `typegpu` (build-time only), `colord`, `somoto`, `electron`, `update-electron-app`.

---

## 6. Draft project schema

Sketch only — validate with zod, version it, and write a migration path before you build UI on it.

**Changed from the desktop draft:** `path` becomes a *storage reference* (ADR-7). There is no filesystem path in a browser, and pretending otherwise is what makes a port hard.

```jsonc
{
  "version": 1,
  "id": "prj_8f2a...",
  "name": "Episode 12",
  "createdAt": "2026-09-27T00:00:00Z",
  "modifiedAt": "2026-09-27T00:00:00Z",

  "canvas": { "width": 1920, "height": 1080, "background": "#000000" },

  "export": {
    "format": "mp4", "video": "avc", "audio": "aac",
    "width": 1920, "height": 1080, "frameRate": 30,
    "bitrate": 10_000_000, "audioBitrate": 128_000, "sampleRate": 48000
  },

  "assets": [
    {
      "id": "ast_1",
      "type": "video",
      // ADR-7: how to get the bytes, not where they are
      "source": { "kind": "handle", "key": "hdl_3f9a" },   // or { "kind": "blob", "key": "ast_1" }
      "name": "A001C003.mov",
      "duration": 812.4, "width": 3840, "height": 2160,
      "frameRate": 29.97, "hasAudio": true,
      "normalized": { "source": "cache/ast_1.mp4", "reason": "undecodable:prores" }
    }
  ],

  // Flat, ordered. z-order = array order. No nesting in v1.
  "clips": [
    {
      "id": "clp_1",
      "assetId": "ast_1",
      "order": 0,
      "start": 0,          // timeline position, seconds
      "duration": 12.5,    // length on the timeline
      "in": 4.0,           // source in-point
      "speed": 1.0,
      "transform": { "x": 0, "y": 0, "scale": 1, "rotation": 0,
                     "anchorX": 0.5, "anchorY": 0.5, "opacity": 1 },
      "keyframes": [
        { "prop": "scale", "time": 0.0,  "value": 1.0, "easing": "easeInOut" },
        { "prop": "scale", "time": 2.0,  "value": 1.5, "easing": "easeOut" }
      ]
    }
  ],

  "overlays": [
    { "id": "ovl_1", "order": 0, "type": "text", "start": 1.0, "duration": 4.0,
      "text": "Chapter One", "font": "Inter", "fontSize": 96,
      "x": 0, "y": -300, "align": "center", "color": "#ffffff" }
  ],

  "captions": {
    "enabled": true, "preset": "classic", "assetId": "ast_2"
  },

  "audio": [
    { "id": "aud_1", "assetId": "ast_3", "start": 12.5, "duration": 0.2,
      "volume": 0.8, "muted": false, "sfx": "click-soft" }
  ],

  "library": { "clips": ["clp_1"], "overlays": ["ovl_1"] }
}
```

### Schema decisions worth making deliberately

- **Flatten nesting.** No groups, no layer trees in v1. Z-order is `order`. You can add groups later without a migration if you reserve the integer now.
- **Seconds, not frames, at the file level.** Frames are a rendering detail. Convert once in `buildWorld`.
- **Reserve `order`.** Array order is fragile once the user can reorder. Included above from day one.
- **Version it and write `migrate.ts` before v1 ships.** You will break someone's project otherwise. This matters *more* in a web app: there is no file the user can diff against their own backups.
- **`source` is a discriminated union.** Adding a third storage kind later (e.g. OPFS) should not be a breaking schema change.
- **`normalized` on the asset.** Record *why* you transcoded. Users will ask, and it makes the cache debuggable.
- **Keep the project file small.** It references assets, it does not embed them. A `project.json` should stay in the kilobytes so it is trivially version-controllable and trivially downloadable.

---

## 7. Build phases

Ordered so that each phase produces something you can show someone.

### Phase 0 — Foundations (1–2 weeks)
- New repo, MPL-2.0, copy `runtime` / `encoder` / `assets` + koota patch
- Delete: reconciler, dapi, agent-chat, cli, genai, dashboard, auth, **all of `apps/desktop`**
- Vite + COOP/COEP verified in CI. `SharedArrayBuffer` is actually available
- **Write tests for the A/V sync invariants** (§11 R3). Do this now, while the code is fresh
- **Spike: does `ffmpeg.wasm` run here, and is an LGPL build obtainable?** (§14)
- **Spike: does export actually work in Safari and Firefox?** (§14, R7)

**Exit:** the copied engine renders and exports a hardcoded scene **in Chrome, in a `worker`**, at a **measured and recorded frames/second**, and you can state whether Safari/Firefox export works.

The FPS number is a gate, not a nicety. R1 is your top risk and it is unmeasured right now.

### Phase 1 — JSON project model (2–3 weeks)
- `packages/project`: zod schema, `buildWorld()`, `history.ts`, `migrate.ts`
- Replace `mount(code, world)` at `capture.ts:144`
- Prove export works from a JSON-authored project, not a JSX one
- Round-trip: load → serialize → load, byte-identical

**Exit:** a hand-written `project.json` exports a correct mp4. This is the highest-risk phase — if `buildWorld` can't reproduce the scene, everything above it is blocked.

### Phase 2 — Media & storage (2–3 weeks)
*This is what Electron used to give you for free. It is now real work and it moved up.*

- `packages/storage`: File System Access handles, IndexedDB blobs, OPFS cache
- `videoTrack.canDecode()` at import → a real error message, not a dark-red rectangle
- Unsupported → lazy-load ffmpeg.wasm → transcode to a browser-decodable intermediate
- Quota reporting via `navigator.storage.estimate()`, shown in the UI
- Revoked/missing handle → a clear, actionable error
- Re-key `packages/assets` off filesystem paths onto storage references
- Test corpus: ProRes 422, DNxHD, 10-bit HEVC, AV1, MKV, AC-3, 5.1, VFR screen recording, odd resolutions, rotated phone footage

**Exit:** "drop anything" is a headline feature, and reopening a project after a browser restart still works.

### Phase 3 — Minimal editor UI (3–4 weeks)
- Timeline: drag, trim, split (`S`), delete (`⌫`), snap
- Canvas: click to select, transform handles
- Inspector: **five controls.** Position, Scale, Rotation, Opacity, Duration. That's it
- Zoom control with a preset dropdown: 100 / 125 / 150 / 200% + fit
- One-tap "Smooth Push In" / "Pull Out" — applies a 2-keyframe `scale` ramp
- Keyboard: space to play/pause, J/K/L, arrow to nudge playhead
- Explicit save / download / re-open project affordances. No autosave illusion you cannot trust (R6)

**Exit:** drop a video, split it, zoom into a moment, export. That's the demo.

### Phase 4 — Text, captions, soundboard (2–3 weeks)
- Import `.srt` → styled subtitles using the existing 7 caption presets
- Text overlays: pick a bundled font, set size/position/align. No font browser in v1
- Bundle ~40 SFX (§9)
- "Snap SFX to nearest cut" using the existing cross-correlation in `audio-sync.ts`

**Exit:** a 2-minute edit with captions and sound design, start to finish.

### Phase 5 — Speed ramps (1–2 weeks)
- `PlaybackRate` is currently constant. Add time-varying rate
- Video: needs frame duplication/dropping or a proper retimer
- Audio: feed the existing WSOLA stretcher a varying factor
- **This is the most technically interesting piece in the MVP.** Budget it honestly

**Exit:** "slow zoom into the moment" — the single most-requested effect in this genre.

### Phase 6 — Polish & ship (ongoing)
- Render performance: `OffscreenCanvas` worker pool. See §11 R1
- PWA install, offline shell
- Export presets: 1080p / 4K / Shorts 1080×1920, no settings panel
- Real error toasts, progress with ETA, cancel
- Error reporting — opt-in, no PII
- Graceful degradation messaging on Safari/Firefox

### Later, not now
Native Tauri wrapper (if demanded) · speed ramp polish · version history · templates · project search · proxy editing for 4K · HDR · vertical-first canvas defaults · text-to-speech (server, so: paid tier)

---

## 8. MVP scope

### In
1. **Drop → normalized if needed → on the timeline, playing**
2. **`S` split, `⌫` delete, drag to move, snap**
3. **Zoom presets 100/125/150/200% + one-tap smooth push-in and pull-out**
4. **Import `.srt` → styled subtitles**
5. **Speed ramp 0.5×/2× with smooth transitions**
6. **Soundboard: ~40 bundled SFX + import + snap-to-cut**
7. **Export: 3 presets (1080p / 4K / Shorts 1080×1920), no settings panel**

### Out of v1 — and this is the discipline that matters
Filters · blend modes · masks · gradients · shapes · nested groups · WGSL shaders · `<html>` compositing · three.js surfaces · nested sequences · transition types beyond cross-dissolve · multiple scenes · keyframes beyond scale/position/opacity · a plugin API · scripting · collaborative editing · cloud anything · **a native desktop app**

The failure mode for "simple editor" projects is shipping a slightly worse Adobe. **Seven things that happen instantly beats two hundred things that are merely available.**

---

## 9. The audio library

There is currently **no SFX library** — `docs/brand/assets/audio/{music,sfx,voiceovers}/` are all empty directories. The mixer is a pure gain tree, so shipping sounds is: bundle WAVs, register them, and the existing volume control just works.

### Format
- 48 kHz, **mono**, 16-bit PCM WAV
- Peak-normalized to about **−3 dBFS**
- Loop-friendly for risers/whooshes (no click at the seam)
- Trim leading/trailing silence aggressively — these get triggered, not listened to
- Keep each under ~200 KB

### Content (~40 to start)
| Category | Count | Notes |
|---|---|---|
| Mouse clicks | 4 | 3 velocity variants + double-click |
| Keyboard | 6 | single keys, mechanical, soft, Enter, Tab, Escape |
| Whooshes | 6 | 3 speeds × 2 directions |
| Risers | 5 | 1s / 2s / 4s, with and without tonal tail |
| Impacts | 5 | low thud, mid, metal, sub, digital |
| UI blips | 6 | notification, error, success, pop |
| Ambience | 5 | room tone, crowd, wind |
| Utility | 3 | air horn, applause, record-stop |

**Delivery in a web app:** these are ~8 MB total. Bundle them in the app and prefetch. Do *not* lazy-load each one over the network mid-edit — a latency spike on a sound effect is worse than the effect.

### The differentiator
`packages/runtime/src/media/audio-sync.ts` (233 lines) already does RMS-envelope extraction at 500 Hz with cross-correlation and parabolic peak refinement, returning `{ offsetSeconds, confidence }`. That means **"place this click exactly on the cut" is nearly free.**

Nobody in the cheap-editor category does this. It costs you maybe two days on top of code that already exists.

### Licensing
**Do not generate these with a model and ship them without checking terms.** Either:
- Record/find CC0 or explicitly-licensed sounds, or
- Use a service whose output you own outright (verify this — most "royalty-free" AI audio has usage restrictions)

Keep a `SOURCES.md` next to `media/sfx/` recording the license of every single file. Auditors will ask.

---

## 10. Known bugs and traps — do not inherit these

Read this before you touch the copied code.

| Trap | Where | What to do |
|---|---|---|
| **Bare spin loop, no timeout** | `encoder.ts:363-404` — `while (Atomics.load(this.buffer, 0) < renderQuantum);` | Hard deadlock if the worker never feeds the worklet. **Far more likely in a web app** — a backgrounded tab, an eviction, or a crashed worker never signals. Add a timeout / abort path when you rewrite |
| **Cancel sentinel is load-bearing** | `encoder.ts:266` — `Atomics.store(buf, 0, 2**31 - 1)` | Chosen because it's unreachable by real audio math but still exits the spin. If it were `Infinity` it'd `ToInt32` to 0 and hang forever |
| **Tail grant is load-bearing** | `encoder.ts:319-332` — `+ sampleRate` on the final flush | Omit it and the last render quantum never gets credit; the promise never settles |
| **Deliberate sub-sample drift** | `encoder.ts:306-309` — `floor(timestamp*sampleRate) - last` | Not a bug, a design choice: bounds drift to <1 sample/frame. Exact math accumulates a sawtooth |
| **Half-sample audio hack** | `audio.ts:133-137` — `start += 0.5 / context.sampleRate` | Applied unconditionally to *every* buffer = global +0.5 sample (~10.4 µs @48k) phase offset. Nobody knows the root cause. **Don't port the offset**; you don't inherit the bug |
| **Silent decode failure** | `video.ts:118-137`, `render.ts:298-330` | Probe only checks the *container*; `ProbeResult` has no codec field. ProRes imports "fine", then renders as a dark-red rectangle `#5C2828` with no message. `SourceError` is never set for decode errors. **Add `canDecode()` at probe time** |
| **Font-load filter bug** | `fonts/utils.ts:90` — `a !== b && c !== d` inside a `.filter()` | Should be `\|\|`. The `&&` removes the wrong entry from the memo ledger |
| **Text re-measured every frame** | `text.ts:436-442` — `renderText` calls `tokenizeText` + `shapeTokens` unconditionally | No cache invalidation. Re-measures and re-shapes all text, 30×/sec. **Free perf win: cache it** |
| **Remote fonts at render time** | `fonts/fixtures.ts` | Fetches from `fonts.gstatic.com` + S3. Hidden network dep in an "offline" app. Bundle locally |
| **Unsorted system enumeration** | `engine/fonts.ts:54-73` | `queryLocalFonts()` returns unsorted; the weight-mapping workaround is fragile. Don't ship a font browser in v1 |
| **System order is load-bearing** | `encoder.ts:280-287` | `playbackSystem` must run *before* `resolverSystem` drains the promises it pushed. Audio is scheduled with absolute times derived from pre-motion state. Reordering silently desyncs |
| **`normalizeSceneTransform` after `motionSystem`** | `encoder.ts:285-286` | The comment says it outright: "May be changed by a system". Skip it and a keyframed scene transform offsets every frame against the audio |
| **`advancePlayhead` must no-op offline** | `playback.ts:42-46` | It self-guards on `Mode !== 'realtime'`. Preserve that or the playhead double-advances |
| **Negative first timestamp clamp** | `video.ts:614-616` | Edit-list head trims (very common in ProRes/Avid exports) would otherwise drift every frame against audio |
| **mediabunny has no `enableForLiveMode`** | — | Doesn't exist in 1.50.6. If you want worker offload, you build it |
| **`discardedTracks` is never read** | `transcode.ts:71-74` | mediabunny gives you a precise reason code and the repo throws it away. Use it — it is exactly how you detect "needs FFmpeg" |

### Traps that are new in a web app

| Trap | Why it is new |
|---|---|
| **Assuming a file path is stable** | There are no paths. Everything re-keys onto a handle or blob id (ADR-7) |
| **Assuming writes are atomic** | `apps/desktop/src/atomic.ts` is a temp+rename dance that no longer applies. A tab crash mid-write loses the project. See R6 |
| **Assuming the tab stays alive** | The A/V sync spin loop (§ above) was survivable in Electron. A backgrounded or evicted tab is not |
| **Assuming one browser** | `queryLocalFonts`, `drawElementImage`, File System Access, and WebCodecs encoder maturity all vary. See R7 |

---

## 11. Risk register

### R1 — Render performance. **Highest user-visible risk.**
Encoding is **frame-serial and single-threaded** (`encoder.ts:263-313`). 1080p30 is 900 render+encode iterations. A 3-minute edit is 5,400 frames. Gated by the slowest of: video encoder, decoder, or the audio worklet handshake.

**Mitigations, in order of cost:**
1. **Measure first, in Phase 0.** `console.info('Encoded frames at X.XXFPS')` already exists at `encoder.ts:315-317`. Get a real number before designing anything. The Phase 0 exit criterion is this number.
2. Honest progress + ETA. Cheap, and buys a lot of patience.
3. `OffscreenCanvas` worker pool for decode + composite. **More necessary in a web app than in Electron** — a long export must not freeze the tab, and there is no main process to hide behind. It is a real project; don't attempt it before you have users.
4. Offload *decode only* to parallel workers first. Much easier than parallel compositing, and decode is often the bottleneck.

### R2 — Format coverage. **Highest risk to the whole product.**
Addressed by ADR-2. Build a **test corpus** early: real camera files, not synthetic ones. ProRes 422 HQ, DNxHD LB, 10-bit HEVC in MOV and MKV, AV1, H.264 high bitrate, VFR from screen recording, AC-3 and DTS audio, 5.1, odd resolutions (720×480, 1440×1080), rotated phone footage.

**Worse than it was in the desktop draft.** There you spawned a real FFmpeg process. Here you may be unable to ship one at all without a GPL exposure (§12), and if you can, it is a 30 MB single-threaded WASM download.

**If a ProRes file doesn't just work, the project is over.** This is the demo. Resolve the licensing question in Phase 0, not Phase 2 — if no LGPL WASM build is obtainable, the product's scope changes and you need to know that before you build a UI around the promise.

### R3 — A/V sync is subtle and untested
There are **zero tests** for `runtime`, `encoder`, or `assets`. The sync logic in §10 has eight separate ways to silently break, and a bare spin loop that deadlocks with no error.

**Mitigation.** Before you change anything in the encoder, write tests that pin the invariants:
- Audio sample count matches `duration × sampleRate` within 1 sample
- Video frame count matches `ceil(duration × frameRate)`
- A/V drift over a 10-minute render stays under 1ms
- Cancel mid-render returns `type: 'canceled'` and doesn't hang
- Muted / silent-audio-input renders don't deadlock the worklet
- **A worker killed mid-render does not leave the spin loop hanging** (new in a web app)

Do this in Phase 0, while the code is fresh.

### R4 — The media core is a black box
You are reading ~15,000 lines of ECS you didn't write, with no tests, and you need to modify the project model underneath it.

**Mitigation.** Resist the urge to refactor. The engine is good. Change the *project format* and the *UI*. Leave the engine alone except for the §10 fixes, each of which should be a test first.

### R5 — Scope creep back toward Adobe
**Mitigation.** Write the §8 out-of-scope list down and keep it visible. Every feature request gets checked against it. The out-of-scope list is the product.

### R6 — Data loss. **New, and arguably now the top product risk.**
The desktop version wrote to a folder. A lost project was a deleted folder. This version writes to browser storage, where a tab crash, an eviction, a cleared "site data", or a user hitting "clear cookies" destroys the project — and the user has no backup, because **there is no file on their disk that we can point them at.** We deliberately do not make a native app that could own a real folder.

**Mitigations:**
- Show storage usage and warn before large imports.
- Explicit, unmissable **download project** and **re-open project** affordances. Never imply an autosave the user cannot verify.
- An explicit, human-readable statement at the top of the export flow: here is your project, here is your video, keep them.
- Keep `project.json` small enough that "save it to disk" is one click (§6).
- Consider a build-time `navigator.storage.persist()` request so the browser stops treating us as disposable.

### R7 — Browser fragmentation. **New.**
WebCodecs is unevenly implemented. Chromium is strong. Safari has supported it since 16.4 but is less battle-tested for encoding. Firefox shipped relatively recently. The File System Access API is Chromium-only, so ADR-7's strong tier is Chromium-only by construction. And a creator audience skews Mac.

**Mitigation.** Spike export in Safari and Firefox in Phase 0 and write down what actually works, before the architecture hardens around Chromium. Decide explicitly whether open-editor is "Chromium-first, degraded elsewhere" or "works everywhere" — and if it's the former, say so on the README instead of shipping a confusing product.

---

## 12. Licensing and legal

### The short version
**Yes, you can build a proprietary cloud product on an MPL-2.0 core. This is explicitly permitted.**

### How MPL-2.0 works
File-level copyleft, not project-level. It triggers only when you *modify* a covered file and *distribute* it.

- Ship open-editor (modified `runtime`/`encoder`/`assets`) under MPL-2.0 → everyone is fine
- Build a closed cloud product on top → your code, your license, your terms
- If you modified an MPL file, **that file** must be available to your users under MPL-2.0
- Preserve license notices in every copied file
- Tell recipients how to obtain the source of the covered software

**A web app makes this materially easier.** You are not distributing a binary; you are publishing files. The source obligation is satisfied by pointing at the public repo. There is no installer to ship, no link-back clause negotiation, no per-binary source tarball.

**And the best part for SaaS: MPL has no network-use clause.** AGPL does; MPL deliberately does not. Running the code on your servers is not a distribution event, so source obligations don't even start.

### ⚠️ The FFmpeg GPL landmine — worse than in the desktop draft

FFmpeg is LGPL-2.1+ *as a project*, but **the default build enables GPL components** — libx264 and libx265 are GPL. Most prebuilt binaries are GPL. If GPL FFmpeg is linked into your closed product, **the whole product must be released under GPL.**

**The desktop plan solved this** by spawning FFmpeg as a separate process — unambiguous mere aggregation, not linking, and it was trivial to record build flags in a document.

**The web plan is worse.** `ffmpeg.wasm` is a library *linked into your JavaScript bundle* in the ordinary sense. Mere-aggregation arguments do not carry over. If the WASM build contains GPL components, you have pulled GPL code into your bundle.

We only need **decoders**. H.264 encoding already goes through WebCodecs, and ProRes, DNxHD, HEVC (built-in decoder) and AC-3 decoders are all LGPL. So an LGPL build would be sufficient — **if one exists.**

Rules to hold:
- Find or build an `ffmpeg.wasm` core compiled with `--disable-gpl`, no `libx264` / `libx265` / `libxvid`
- Verify the flags yourself. Do not trust a package's README.
- Record the exact build flags in `licenses/FFMPEG.md` so an auditor can check
- **Pin the exact version.** A WASM binary is opaque; a floating tag can change under you.
- If no LGPL build is obtainable, do not ship it. Cut scope to browser-decodable formats and say so.

### Other licenses
| Component | License | OK? |
|---|---|---|
| diffusionstudio `runtime`/`encoder`/`assets` | MPL-2.0 | Yes — keep headers, publish source of modified files |
| `mediabunny` 1.50.6 | MPL-2.0 | Yes — same rules |
| `koota` 0.6.6 | ISC | Yes — permissive. **But it's patched; carry the patch** |
| `animejs` 4.5.0 | MIT | Yes |
| `solid-js` 1.9.14 | MIT | Yes |
| `zod`, `kobalte`, `vite` | MIT | Yes |
| `@ffmpeg/ffmpeg` | **verify — see above** | ⚠️ |
| Bundled SFX | CC0 or equivalent | ⚠️ Document per file in `media/sfx/SOURCES.md` |

### Trademarks
**MPL-2.0 does not grant trademark rights.** The "Diffusion Studio" name, logo, and brand are not covered by the code license. Don't ship under their brand. If you fork or reuse, use your own name and marks.

### ⚠️ The question you must answer first
**Are you the copyright holder of `diffusionstudio/editor`, or working on it under an agreement?**

MPL grants every recipient broad rights to use, modify, and distribute — including commercially. But each contributor licenses only their own contributions, and the *brand* is not licensed. If you're an employee, your employment agreement matters. If you're not the owner, MPL still lets you use the code, but a conversation with the founder is far better than discovering a problem later.

### Before commercial launch
Talk to a lawyer about: the ffmpeg.wasm build, your agreement with the diffusionstudio repo, and the SFX licenses. **Skip this for the prototype — except the ffmpeg question, which is a build-time decision, not a launch-time one.**

---

## 13. Business model

The license permits it. The *product* is the harder question.

### The tension — and the web switch sharpened it
You pitched "no servers at all." That's a genuine differentiator, and ADR-8 makes it structurally true. But a hosted web app is closer to CapCut's shape than a desktop app was, and §2 names CapCut as the competitor. The differentiator is no longer "local" — it is **"no account, no upload, nothing leaves your device, and it loads instantly."** That is still a real wedge, but it needs to be said out loud, because a URL alone does not communicate it.

### What the cloud should sell
Not "the parts we removed from the local app." The things local *cannot* do:

- **Sync across devices** — start on desktop, finish on laptop. Note this is now a bigger gap than it was, since the local app is itself a website; you are selling "your project follows you," which is a harder pitch than "your files never left your disk"
- **Shareable links** — send a creator a review link, they comment on a timestamp
- **Version history** — projects are browser storage. People will lose work and blame you. See R6
- **Team libraries** — shared SFX, brand presets, templates
- **Heavy lifting in the cloud** — AI generation (image, video, TTS, audio), and, if you want a clean answer to R2, server-side transcode for the formats the browser can't take

**The strongest play:** ship a genuinely free, genuinely private, genuinely useful editor and charge only for AI and for the things a browser cannot do. That's a much easier story than Adobe, and it means the OSS core is honestly good rather than crippled.

### The trap
**Cloud sync contradicts "nothing leaves your device."** Users will feel it. Worse than in the desktop draft, because a synced project has to leave the device to exist anywhere else.

If you do it: make sync opt-in and explicit, never make the local path depend on it, and let people work entirely offline forever without a nag.

### Also consider
- Most of your audience is price-sensitive. CapCut is free. Your conversion ceiling is low.
- The moat is not the editor — it's the SFX library and the templates. Those compound.
- Distribution just got easier. It is a URL and a GitHub repo. No signing, no notarization, no Homebrew, no update server.
- The URL is also the marketing problem. Nobody type-says "open-editor.app" from a YouTube video. You still need a memorable domain and a demo GIF.

---

## 14. Open questions

**Resolve the first four before Phase 0 exits.**

- [ ] Am I the copyright holder of diffusionstudio, or do I have an agreement? (§12)
- [ ] **Can I find or build an LGPL `ffmpeg.wasm` core?** If not, ProRes is out of scope and the product changes. (§12, R2)
- [ ] **Does export actually work in Safari and Firefox?** WebCodecs maturity varies and the audience skews Mac. (R7)
- [ ] **What's the real render speed?** Measure it before designing anything. (R1)
- [ ] Is Safari's storage quota enough for multi-GB media? If not, the fallback degrades to "re-link the file each session," which changes the promise. (R6, ADR-7)
- [ ] Chromium-first, or works everywhere? Decide explicitly. (R7)
- [ ] Which 3 export presets matter most — Shorts, 1080p, 4K? Probably those three.
- [ ] Does the moat exist? Is it the SFX library, the templates, or the speed?
- [ ] Vertical-first or landscape-first canvas defaults? Probably ask, don't guess.
- [ ] How do we make the promise legible? A URL doesn't say "nothing leaves your device." (R7, §13)
- [ ] Proxy editing for 4K — is raw 4K editing fast enough that users won't notice? Test before building.
- [ ] What's the non-negotiable floor? What single feature, if missing, makes the tool useless?

---

## 15. Reference — key files in diffusionstudio

Clone: `github.com/diffusionstudio/editor` @ `0.206.0`

### Keep
| File | Lines | What |
|---|---|---|
| `packages/runtime/src/systems/render.ts` | 916 | Canvas2D compositor. 28 functions |
| `packages/runtime/src/systems/motion.ts` | 512 | Preset animations + keyframe interpolation |
| `packages/runtime/src/utils/text.ts` | 709 | Text layout (cache it — see §10) |
| `packages/runtime/src/media/audio.ts` | — | Decode, trim, gain, WSOLA wiring |
| `packages/runtime/src/media/time-stretcher.ts` | 260 | Hand-written WSOLA |
| `packages/runtime/src/media/audio-sync.ts` | 233 | Cross-correlation. Free "snap to cut" |
| `packages/runtime/src/media/caption/*` | 1,268 | 7 caption presets |
| `packages/runtime/src/traits/*` | — | transform, timing, motion, style, text, audio |
| `packages/runtime/src/world/serialize.ts` | — | JSON round trip. Reuse for undo/redo |
| `packages/encoder/src/encoder.ts` | — | The encode loop + A/V sync. **Read §10 first** |
| `packages/assets/src/*` | 2,153 | Manifest, probe, hashing, peaks — **re-key onto storage refs** |
| `patches/koota+0.6.6.patch` | — | **Required** |

### Delete
| File | Lines | Why |
|---|---|---|
| `packages/reconciler/src/*` | 2,496 | Replaced by `buildWorld(json)` |
| `apps/web/src/utils/gen-ai.ts` | 599 | Server-bound |
| `apps/web/src/components/genai/*` | 2,584 | Server-bound |
| `apps/web/src/context/auth.tsx` | 322 | Supabase |
| `apps/web/src/lib/{supabase,trpc,checkout,uploads,analytics}.ts` | — | Server |
| **`apps/desktop/**`** | ~5,200 | No desktop shell. Main process, IPC, preload, native dialogs, `edit.ts` |
| `packages/dapi`, `apps/cli`, `packages/agent-chat` | — | MCP server, agent chat |

### Read for understanding, don't copy
`apps/web/src/engine/capture.ts` — how a second offline world is built for export. `mount(code, world)` at line 144 is the seam.
`apps/web/src/components/sidebar-right/inspector/interpolation.tsx` (988 lines) — a complete keyframe editor. Useful reference, way too much for v1.
`apps/desktop/src/main.ts` — Electron setup: COOP/COEP, `backgroundThrottling: false`, the Chromium `drawElementImage` flag. **Not copied** — but read it for the header configuration and the Chromium-specific flag, both of which still apply in a browser.
`apps/desktop/src/atomic.ts` — read it to understand what durability you gave up. See R6.

---

## Appendix: Session notes

- Audited `diffusionstudio/editor` for what is local vs. server-coupled
- **Revised 2026-09-28: dropped the Electron desktop shell in favour of a web-first PWA.** The engine was already browser-native, so this was a packaging change rather than a port. Consequences: ADR-2 (ffmpeg.wasm lazy), ADR-5 (no shell), new ADR-7 (two-tier storage), new ADR-8 (static host); Phase 2 became media & storage and moved ahead of the UI; new risks R6 (data loss) and R7 (browser fragmentation)
- Found a corrupted `node_modules` (truncated `typed-binary` and `uri-js` source maps) breaking Vite dep optimization. Fixed by reinstalling both packages and clearing the Vite cache. **If you hit "Unterminated string literal" in `node_modules/*.map`, it's truncated install files — delete the package and `npm install`.**
- Temporarily disabled the auth gate in the diffusionstudio checkout (one line, `context/auth.tsx:296`) to test the app. **That edit is still uncommitted in that repo. Revert it with `git checkout apps/web/src/context/auth.tsx`.**
