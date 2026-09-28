# ADR-6: Snapping applies to trims only

**Status:** Accepted.

## Context

Two gestures happen in the same place: dragging a clip body to move it, and
dragging a trim handle to cut it. It is tempting to snap both.

## Decision

**Only trims snap.** Moving a clip follows the pointer exactly.

## Why

Snapping is a property of *cutting*, not of *moving*. A trim handle is placed by
eye, so a small magnetic zone around each cut lets you return to a previous cut
without pixel-hunting.

A move is different. A clip that leaps sideways as it passes a boundary is not
magnetic, it is broken, and it makes fine positioning impossible — the thing you
are doing when you move a clip is positioning it to the frame.

The playhead is excluded for the same reason. Snapping *places* clips; the
playhead *tells time*. A playhead that jumps to the nearest edge stops being a
measurement — when you drag it to check what is at 1:14, you want 1:14, not 1:14
snapped to a boundary.

## How it is enforced

Not by convention. A convention is a comment, and comments get ignored:

- `snapping.ts` exports **exactly one** snapping function, `snapTrimEdge`.
  `snapClipMove` was deleted rather than left unused.
- The `Drag` discriminated union carries `locked` on the **trim variants only**,
  so the move arm is not physically capable of latching onto a target and the
  compiler rejects an attempt.
- The move arm references no snapping symbol, builds no target list, and never
  sets a guide line.
- `test/snapping.test.ts` asserts the exported-symbol count *from the source*, so
  re-adding a move helper fails the build.

## Consequences

- Moving a clip is pixel-exact at every zoom level.
- Trimming is forgiving.
- Crossing a neighbour to the left is a **swap**, not a magnet, because a clip may
  never overlap its predecessor.
