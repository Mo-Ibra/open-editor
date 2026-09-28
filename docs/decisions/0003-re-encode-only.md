# ADR-3: Re-encode on export, with no stream-copy fast path

**Status:** Settled by measurement (2026-09-28). Will not be revisited.

## Context

Export could either re-encode every frame, or copy compressed packets straight
through ("stream copy" / remux) where the format allows it. Stream copy is much
faster where it works.

## Decision

Every export re-encodes.

## Alternatives considered

- **Stream copy where possible.** Rejected. Concatenating clips from two different
  files with different codecs or resolutions *must* re-encode. Stream copy only
  survives the narrow case of one source file, cuts only, no zoom, no text. That
  is not a headline feature; it is a special case with its own correctness
  problems.

## The measurement that settled it

The original plan said: *"if 1080p re-encodes at 30+ fps, re-encoding is fine."*

Measured on a Linux laptop: **154 fps at 1080p, 5.13× realtime** — and that is
the *easy* case (3.75 fps VFR screen recording, near-static content). See
[risks.md](../risks.md#r2--encode-speed) for the full numbers and why they are
flattering.

Re-encoding is comfortably faster than realtime, so the fast path is not needed.
**The timeline stays frame-accurate and the user never sees a cut snap to a
keyframe** — which is worth more than the speed would have been.

## Consequences

- Output is frame-accurate, always.
- No stream-copy code paths to test, no keyframe-aligned edge cases.
- The cost is export time, which the measurement says is acceptable.
