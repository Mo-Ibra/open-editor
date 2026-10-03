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

**Every gesture snaps, each under its own toggle.** A dragged clip pulls its
start or its end to a nearby clip edge or the timeline start; a trim handle pulls
its edge the same way; and the playhead, while scrubbed, pulls to the nearest
edge. They are three independent toggles:

- *clip snap* — clips in the same lane, and the timeline start;
- *lane snap* — also clips in the other lane, so picture lines up with sound once
  a pair has been broken apart;
- *playhead snap* — the scrubber, onto clip edges and the timeline start.

Any combination can be on. The playhead is never a *target*: nothing snaps *to*
it, only it snaps to edges.

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
- **Snap other clips to the playhead.** Not taken. The playhead is a
  measurement, and clicking to grab a handle seeks the playhead to that handle
  anyway, so an edge would mostly snap back to where the grab started. The useful
  direction is the playhead snapping *to* edges, which is its own toggle.

## Consequences

- `model/snapping.ts` exports three functions: `snapMove`, `snapTrimEdge` and
  `snapPlayhead`.
- The `Drag` union carries `locked` on all three variants, so each latches. The
  toggles are read separately — `snapping()` (clip/lane) for moving and trimming,
  `playheadSnap()` for the scrubber — so one mode cannot switch another on.
- A move snaps against a target list **captured at drag start and restricted to
  targets that do not move with the drag** — the clips before the first selected
  one, the other lane, and the timeline start, plus the next clip's start as an
  end-only butt target. Moving pushes the clips after it, so their edges travel
  with the drag; a target that travels with the drag is a target the clip chases,
  and that is the vibration. Restricting to fixed targets removed it. Trims and
  the playhead rebuild theirs, because neither pushes anything.
- `test/snapping.test.ts` pins that the playhead is never a *target*, that the
  three exported functions are the whole surface, and that neither clip toggle
  reaches the playhead arm or vice versa.
