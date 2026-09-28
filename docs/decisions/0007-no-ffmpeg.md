# ADR-7: No ffmpeg.wasm

**Status:** Accepted.

## Context

An earlier draft of the plan used `ffmpeg.wasm` to handle exotic input formats.

## Decision

Dropped. This is a browser application built on WebCodecs and mediabunny.

## Why

- A 30 MB lazy download.
- Single-threaded.
- **Its stock builds ship GPL components**, which would poison the bundle and
  constrain the licence of everything built on top.

## Alternatives considered

- **Ship it anyway, in a separate optional path.** Rejected for now: the licence
  exposure is not worth a feature that may never be used. Revisit only if codec
  breadth turns out to be the main thing people want.

## Consequences

Stated plainly, because it is the main reason ProRes users will not use this:

- **Handled:** H.264 and VP9 everywhere; HEVC and AV1 on Safari and recent
  Chromium.
- **Not handled at all:** ProRes, DNxHD, AC-3, 10-bit HEVC.

This is a permanent scope limit, not a phase. It is the main reason the project
is a prototype rather than a venture: ship it, see who shows up, and only then
decide whether codec breadth is worth a GPL fight.
