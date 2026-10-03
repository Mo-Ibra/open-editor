# ADR-11: Snapping applies to moves as well as trims

**Status:** Accepted. Supersedes [ADR-6](0006-trim-only-snapping.md).

## Context

ADR-6 made snapping a property of cutting only: a trim handle pulls to a nearby
cut, a moved clip follows the pointer exactly. That is a defensible reading of
the gesture, and in practice it is the wrong one. The alignment people reach for
most often is on the clip they are *moving* — butting a clip against the one
before it, or landing its end on a neighbour's start — and with no magnet there,
"snap on" reads as broken rather than deliberate. The status bar and the toolbar
even advertised that clip edges snapped, which they did not.

## Decision

**Both gestures snap.** A dragged clip pulls its start or its end to a nearby
clip edge or the timeline start; a trim handle pulls its edge the same way. The
playhead stays excluded: snapping *places* clips, the playhead *tells time*, and
a playhead that jumps to the nearest edge stops being a measurement.

## Why both edges

A move is only usefully magnetic if either edge can take the pull. Butting the
start against the previous clip and landing the end on the next one are
different intents, and forcing one of them means the magnet fires on the wrong
edge half the time. `snapMove` takes whichever of the two edges is nearer a
target; the clip's own edges are excluded, so it cannot latch onto itself.

## Alternatives considered

- **Trim-only, as ADR-6.** Rejected: it satisfies a rule the user cannot see and
  violates the one they expect. The rule was legible in the code and invisible in
  the product.
- **Snap the whole group's outer edges.** For a multi-selection this would pull
  the grabbed clip away from the pointer when an outer clip latched. The group
  snaps on the anchor clip and the rest follow by the same delta, so the grabbed
  clip always lands where the pointer is.
- **Snap to the playhead too.** Not taken here. The playhead is a measurement,
  and clicking to grab a handle seeks the playhead to that handle anyway, so it
  would mostly snap the edge back to where the grab started.

## Consequences

- `model/snapping.ts` exports two functions: `snapMove` and `snapTrimEdge`.
- The `Drag` union carries `locked` on the move and trim variants; the playhead
  drag is the only one that cannot latch.
- A move snaps against a target list **captured at drag start**, not one rebuilt
  each frame. Moving pushes the clips after it, so their edges travel with the
  drag; a live list made the clip chase a target that moved with it, which
  showed up as a vibration. Trims rebuild theirs, because trimming pushes
  nothing.
- `test/snapping.test.ts` pins that the playhead never snaps and that the two
  exported functions are the whole surface.
