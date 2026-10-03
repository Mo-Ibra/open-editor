/**
 * Magnetic snapping.
 *
 * The whole feature is a function: given where a drag *wants* to put something,
 * and the set of things worth aligning to, return where it should actually go.
 * Pure, so the behaviour that decides whether this feels magnetic or feels
 * broken can be tested without a mouse.
 *
 * Three details do all the work, and skipping any of them is why most snapping
 * implementations feel wrong:
 *
 *  1. **The threshold is in pixels, not seconds.** A 10-pixel tolerance at
 *     20 px/s is half a second; at 400 px/s it is 25 ms. Converting the
 *     pixel distance into seconds at the current zoom is what makes the pull
 *     feel identical at every zoom level.
 *
 *  2. **A snap is sticky.** Once a drag latches onto a target it keeps that
 *     target until the pointer moves further from it than the threshold.
 *     Re-deciding every frame makes a clip flicker in and out of alignment as
 *     the pointer jitters around the boundary, which reads as broken.
 *
 *  3. **A clip is never a snap target for itself.** Otherwise it snaps to its
 *     own edge and refuses to move at all.
 */

import { clipDuration, clipStarts, laneOf, type Clip, type Lane, type Project } from './project.js'
import type { SilenceRegion } from '../media/peaks.js'

export type SnapKind = 'clip-start' | 'clip-end' | 'playhead' | 'timeline-start' | 'silence'

export interface SnapTarget {
  time: number
  kind: SnapKind
  /** The lane that produced it, or null for global targets. */
  lane: Lane | null
  /** The clip that produced it, so a drag of that clip can ignore it. */
  clipId: string | null
}

export interface CollectOptions {
  playhead: number
  includePlayhead: boolean
  /** Per-asset silence regions, keyed by assetId, mapped to timeline time by
   *  the caller because only the caller knows the clip layout. */
  silence?: { clipId: string; lane: Lane; regions: SilenceRegion[]; start: number }[]
  /**
   * Which lanes contribute clip edges. Defaults to both.
   *
   * The timeline passes one lane for "clip snap" (align within a lane) and the
   * other for "lane snap" (align picture to sound), so the two toggles are
   * independent.
   */
  lanes?: readonly Lane[]
}

/**
 * Every alignment worth offering.
 *
 * Clip edges from **both** lanes, so a video edge lines up with an audio edge
 * and vice versa — which is the case people actually want when trimming speech.
 */
export function collectTargets(project: Project, options: CollectOptions): SnapTarget[] {
  const targets: SnapTarget[] = [{ time: 0, kind: 'timeline-start', lane: null, clipId: null }]

  if (options.includePlayhead) {
    targets.push({ time: options.playhead, kind: 'playhead', lane: null, clipId: null })
  }

  for (const lane of options.lanes ?? (['video', 'audio'] as const)) {
    const clips = laneOf(project, lane)
    // One pass per lane. This is called on every trim `pointermove`, and it used
    // to ask `clipStart` per clip, so it was the hottest quadratic in the app.
    const starts = clipStarts(clips)
    for (let i = 0; i < clips.length; i++) {
      const start = starts[i]!
      const clipId = clips[i]!.id
      targets.push({ time: start, kind: 'clip-start', lane, clipId })
      targets.push({ time: start + clipDuration(clips[i]!), kind: 'clip-end', lane, clipId })
    }
  }

  // Both edges of a silence region, not just the start. Cutting dead air means
  // snapping to where the speech *resumes*, which is the region's end — a
  // target list with only the start is the less useful half.
  for (const entry of options.silence ?? []) {
    for (const region of entry.regions) {
      targets.push({
        time: entry.start + region.start,
        kind: 'silence',
        lane: entry.lane,
        clipId: entry.clipId,
      })
      targets.push({
        time: entry.start + region.end,
        kind: 'silence',
        lane: entry.lane,
        clipId: entry.clipId,
      })
    }
  }

  return targets
}

/** The target nearest to `time`, within `threshold`, or null. */
export function nearestTarget(
  time: number,
  targets: SnapTarget[],
  threshold: number,
  exclude?: { clipId?: string | null; lane?: Lane | null },
  locked?: SnapTarget | null,
): SnapTarget | null {
  // Sticky: a latched drag keeps its target until it drifts too far, rather
  // than re-deciding every frame and flickering.
  if (locked) {
    const distance = Math.abs(locked.time - time)
    if (distance <= threshold * STICKY_FACTOR) return locked
  }

  let best: SnapTarget | null = null
  let bestDistance = threshold

  for (const target of targets) {
    if (exclude?.clipId && target.clipId === exclude.clipId) continue
    // `<=`, so a value exactly on the threshold snaps. With `<` it does not,
    // and a test for the boundary only passes by accident of float
    // representation — 10.2 - 10 is 0.19999... which is under 0.2 anyway.
    // The rule is inclusive; make the code say so.
    const distance = Math.abs(target.time - time)
    if (distance <= bestDistance) {
      bestDistance = distance
      best = target
    }
  }

  return best
}

/** A latched target survives up to 1.6x the threshold before releasing. */
const STICKY_FACTOR = 1.6

/**
 * Snap a single trim edge.
 *
 * A trim handle is placed by eye, so an invisible magnetic zone around each cut
 * lets you return to a previous cut without pixel-hunting. `snapMove` does the
 * same for a moving clip; together they are the whole snapping surface.
 *
 * `edge` is the value the drag is proposing for the edge in question.
 */
export function snapTrimEdge(
  edge: number,
  targets: SnapTarget[],
  threshold: number,
  exclude?: { clipId?: string | null; lane?: Lane | null },
  locked?: SnapTarget | null,
): { time: number; target: SnapTarget } | null {
  const target = nearestTarget(edge, targets, threshold, exclude, locked)
  return target ? { time: target.time, target } : null
}

export interface MoveSnap {
  /** The clip start after snapping (its far edge may be the one that latched). */
  start: number
  target: SnapTarget
  /** Which edge of the moving clip aligned. */
  edge: 'start' | 'end'
}

/**
 * Snap a clip while it is being moved.
 *
 * Both edges are candidates, so a clip can be pulled so its start meets a
 * neighbour's end (butting) or its end meets a neighbour's start — whichever is
 * nearer to a target. The clip's own edges are excluded, so it cannot latch onto
 * itself and stick.
 *
 * **There is deliberately no end-only target list.** There used to be one: the
 * next clip's start, so a clip could "butt forward" against it. It was dead code,
 * and dead in a way worth recording:
 *
 * - the next clip is *pushed* by the move, so it travels with the drag — and
 *   ADR-11's own rule is that a target which travels with the drag is the thing
 *   that makes snapping vibrate. `movingInLane` excludes those clips from
 *   `targets` for exactly this reason, and this list was the one place they came
 *   back in;
 * - the list was built once at pointerdown, alongside `targets`, so its *time* was
 *   frozen at the drag's start while the clip it named moved away. Measured: after
 *   about 0.12s of drag — one snap radius at 80px/s — it was permanently out of
 *   range and could never fire again;
 * - and "butt forward" has no meaning in this model anyway. Position is derived,
 *   so a clip dragged right *pushes* its successor along rather than running into
 *   it: the successor is always exactly one clip-length away. There is no collision
 *   to butt against, so there was nothing for the target to pull towards.
 *
 * This is the counterpart to `snapTrimEdge`; together they are the whole
 * snapping surface. Moving snaps now (see ADR-11), where it once did not.
 */
export function snapMove(
  proposedStart: number,
  duration: number,
  targets: SnapTarget[],
  threshold: number,
  exclude?: { clipId?: string | null; lane?: Lane | null },
  locked?: SnapTarget | null,
): MoveSnap | null {
  const edges: { edge: 'start' | 'end'; time: number }[] = [
    { edge: 'start', time: proposedStart },
    { edge: 'end', time: proposedStart + duration },
  ]
  const align = (edge: 'start' | 'end', time: number): number => (edge === 'start' ? time : time - duration)

  // Sticky: keep the edge latched to its target until the pointer drifts past
  // the release distance, rather than flickering in and out of alignment.
  if (locked) {
    for (const e of edges) {
      if (Math.abs(locked.time - e.time) <= threshold * STICKY_FACTOR) {
        return { start: align(e.edge, locked.time), target: locked, edge: e.edge }
      }
    }
  }

  let best: MoveSnap | null = null
  let bestDistance = Infinity
  for (const e of edges) {
    const target = nearestTarget(e.time, targets, threshold, exclude, null)
    if (!target) continue
    const distance = Math.abs(target.time - e.time)
    if (distance < bestDistance) {
      bestDistance = distance
      best = { start: align(e.edge, target.time), target, edge: e.edge }
    }
  }
  return best
}

export interface PlayheadSnap {
  time: number
  target: SnapTarget
}

/**
 * Snap the playhead to a nearby edge.
 *
 * The playhead has no lane and no duration, so unlike a move or a trim it just
 * pulls to the nearest target within the threshold. The targets are every clip
 * start and end (both lanes) plus the timeline start, so the playhead lands on
 * a real edit point rather than near it.
 *
 * This is its own mode. It does not consult the clip- or lane-snap toggles, and
 * they do not consult it.
 */
export function snapPlayhead(
  time: number,
  targets: SnapTarget[],
  threshold: number,
  locked?: SnapTarget | null,
): PlayheadSnap | null {
  const target = nearestTarget(time, targets, threshold, undefined, locked)
  return target ? { time: target.time, target } : null
}

/** Convert a pixel tolerance into seconds at the current zoom. */
export function thresholdInSeconds(pixels: number, pixelsPerSecond: number): number {
  return pixelsPerSecond > 0 ? Math.abs(pixels) / pixelsPerSecond : 0
}

/**
 * Which lanes contribute clip edges as snap targets for a drag in `lane`.
 *
 * `clipSnap` contributes the dragged clip's own lane (align within a row);
 * `laneSnap` contributes the other one (align picture to sound). The two are
 * independent toggles, so either, both, or neither can be on.
 *
 * **Shared, because two callers need it and they must agree.** A drag and a drop.
 * When they disagreed, the drop cue snapped to same-lane clip edges with clip
 * snap visibly switched off in the toolbar — a toggle that was a lie for drops.
 */
export function targetLanes(lane: Lane, clipSnap: boolean, laneSnap: boolean): Lane[] {
  const out: Lane[] = []
  if (clipSnap) out.push(lane)
  if (laneSnap) out.push(lane === 'video' ? 'audio' : 'video')
  return out
}

/** Human-readable label for the guide line. */
export function describeTarget(target: SnapTarget): string {
  switch (target.kind) {
    case 'playhead':
      return 'playhead'
    case 'timeline-start':
      return 'start'
    case 'silence':
      return 'silence'
    case 'clip-start':
      return 'edge'
    case 'clip-end':
      return 'edge'
  }
}

void ({} as Clip)
