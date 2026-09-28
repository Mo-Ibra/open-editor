# ADR-5: Never busy-wait an encoder queue

**Status:** Accepted, with a correction.

## Context

A 3-minute 1080p export is 5,400 frames. If the loop enqueues frames faster than
the encoder drains them, all 5,400 `VideoFrame` objects are live at once, holding
GPU memory.

## Decision

Do not spin. Await an event.

```ts
// WRONG — allocates unbounded, OOMs, and a spin loop deadlocks the tab
while (encoder.encodeQueueSize > 0) { /* busy-wait */ }

// RIGHT — await an event, and it cannot deadlock
if (encoder.encodeQueueSize > 16) {
  await new Promise(r => encoder.addEventListener('dequeue', r, { once: true }))
}
```

This is the number one crash cause in browser video export. It is not optional
and it is not a performance optimisation.

## The correction

This ADR was originally written assuming we would drive a raw `VideoEncoder`.
We do not. mediabunny's `CanvasSource.add()` and `AudioBufferSource.add()`
return a promise that resolves when the source can accept more, so the library
owns the queue and its backpressure.

The rule is therefore now a constraint on **how we call it** — we must await
`add()`, never fire and forget — rather than something we implement ourselves.

## Consequences

- The export loop cannot deadlock the tab.
- The `dequeue` pattern is still documented here because the reasoning applies to
  any raw WebCodecs use, and because the failure mode is severe enough to be
  worth recognising on sight.
