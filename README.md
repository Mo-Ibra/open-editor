# open-editor

A video cutter that runs in a tab. Drop files, cut them, export. Nothing to
install, nothing uploaded, no account.

It is a **cutter**, not an NLE. Trim the ends, cut out the dead air, drop the
mistake, fix the camera card. It is deliberately not trying to be Premiere.

---

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
```

```bash
npm test           # 9 suites, no browser needed
npm run typecheck  # tsc --noEmit
npm run build      # typecheck + production build
```

Requires a browser with WebCodecs — Chrome, Edge, or any recent Chromium.
Firefox and Safari are untested; see [docs/risks.md](docs/risks.md#r3--browser-fragmentation).

## What it does today

- Import video/audio files, probed entirely in-browser
- Two linked lanes (video + audio) with breakable links
- Trim, split, duplicate, delete, reorder, leave deliberate gaps
- Multi-select with Ctrl-click, act on the whole selection
- Waveform display, per-clip gain and mute on the audio lane
- Trim-only magnetic snapping (moving clips stays pixel-exact)
- Undo/redo, resizable panels, custom context menus
- Export to MP4 or WebM, with the format negotiated against what your browser
  can actually encode

## The promises

These are the constraints the design is built around. Breaking one is a bug.

1. **No account, ever.** Not a trial, not an email gate.
2. **Nothing leaves the device.** There is no upload path in this codebase and
   there will never be one.
3. **Preview == export.** The same function draws both
   ([ADR-1](docs/decisions/0001-one-render-function.md)). If the preview looks
   right, the file is right.
4. **No install.** It runs in a tab.
5. **The source file is never modified.** Cutting is a change to a list, not to
   bytes on disk ([ADR-2](docs/decisions/0002-source-is-immutable.md)).
6. **Every action is instant.** Drop → playable. Split → done.

## Honest limits

- **Formats are whatever a browser can decode.** H.264 and VP9 everywhere; HEVC
  and AV1 on Safari and recent Chromium. **ProRes, DNxHD, AC-3 and 10-bit HEVC
  not at all** — supporting them means a GPL fight over ffmpeg.wasm
  ([ADR-7](docs/decisions/0007-no-ffmpeg.md)).
- **Project persistence is not implemented.** Reload and the timeline is gone.
  Panel sizes survive, in `localStorage`.
- **Export runs on the main thread.** A long export blocks the tab, and the
  cancel button is the only thing that still responds.

## Documentation

Start at [docs/README.md](docs/README.md).

| | |
|---|---|
| [architecture.md](docs/architecture.md) | The modules and how they connect |
| [data-model.md](docs/data-model.md) | Lanes, links, gaps, derived positions |
| [media.md](docs/media.md) | Probing, VFR, rotation, frame cache, waveforms |
| [export.md](docs/export.md) | The export pipeline and codec negotiation |
| [development.md](docs/development.md) | Commands, test seams, adding tests |
| [decisions/](docs/decisions/) | ADRs — why things are the way they are |
| [risks.md](docs/risks.md) | What is known to be fragile |
| [roadmap.md](docs/roadmap.md) | What is next, and what is undecided |
