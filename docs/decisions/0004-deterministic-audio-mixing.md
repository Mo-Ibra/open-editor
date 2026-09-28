# ADR-4: Deterministic audio mixing, not Web Audio graphs

**Status:** Accepted.

## Context

There are two ways to build an audio mix in a browser: an `OfflineAudioContext`
graph of `GainNode`s, or plain arithmetic into a `Float32Array`.

## Decision

Build the whole mix as a plain `Float32Array`, sample by sample, then encode it.
No `OfflineAudioContext`, no graph.

## Alternatives considered

- **`OfflineAudioContext` with `GainNode`s.** Rejected. A graph is stateful, hard
  to reason about, and its output depends on graph construction order. For a
  cutter that only needs trim-and-concatenate, a graph is enormous overkill.

## Consequences

- Float32 arithmetic is exact, order-independent, and testable with a three-line
  assertion.
- The mix can be asserted on directly, with no audio hardware. See
  `test/export-audio.test.ts`.
- The trade-off is that Web Audio's resampling and channel layout are not free —
  `audio.ts` conforms sample rate and downmixes channels by hand, because feeding
  a 96 kHz source straight to an encoder that only accepts 44.1/48 kHz throws and
  kills the export.
