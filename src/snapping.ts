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

import { clipDuration, clipStart, laneOf, type Clip, type Lane, type Project } from './project.js'
import type { SilenceRegion } from './peaks.js'

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

  for (const lane of ['video', 'audio'] as const) {
    const clips = laneOf(project, lane)
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i]!
      const start = clipStart(clips, i)
      targets.push({ time: start, kind: 'clip-start', lane, clipId: clip.id })
      targets.push({ time: start + clipDuration(clip), kind: 'clip-end', lane, clipId: clip.id })
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
 * Snap a single edge. **This is the only snapping entry point, and it exists
 * for trimming.**
 *
 * Snapping is a property of *cutting*, not of *moving*. A trim handle is
 * placed by eye, so an invisible magnetic zone around each cut lets you return
 * to a previous cut without pixel-hunting. Moving a whole clip, by contrast,
 * must follow the pointer exactly: a clip that leaps sideways as it passes near
 * a boundary is not magnetic, it is broken, and it makes fine positioning
 * impossible.
 *
 * Hence there is no `snapClipMove`. If a future feature wants snapping while
 * moving, it has to be built deliberately rather than re-enabled by accident.
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

/** Convert a pixel tolerance into seconds at the current zoom. */
export function thresholdInSeconds(pixels: number, pixelsPerSecond: number): number {
  return pixelsPerSecond > 0 ? Math.abs(pixels) / pixelsPerSecond : 0
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
