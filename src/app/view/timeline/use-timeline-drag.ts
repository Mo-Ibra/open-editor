/**
 * The timeline's gesture controller.
 *
 * Every pointer and wheel interaction on the timeline lives here: seeking,
 * scrubbing, moving, trimming, right-click, and ctrl+wheel zoom. It is a hook
 * rather than a class because it owns reactive state (the snap guide) and needs
 * no identity of its own.
 *
 * **The one thing worth reading here is the `Drag` union.** `locked` — the
 * latched snap target — is carried by every variant that snaps. There are three
 * independent snapping modes: clip and lane snapping while moving or trimming
 * (ADR-11), and a separate playhead snap while scrubbing. Each is gated by its
 * own toggle and uses its own target list, so one cannot switch another on.
 */

import { createEffect, createSignal, onCleanup, onMount, type Accessor } from 'solid-js'

import {
  clipAtLane,
  clipDuration,
  clipEnd,
  clipStart,
  laneOf,
  movingInLane,
  type Lane,
} from '../../../model/project.js'
import {
  collectTargets,
  describeTarget,
  snapMove,
  snapPlayhead,
  snapTrimEdge,
  thresholdInSeconds,
  type SnapTarget,
} from '../../../model/snapping.js'
import { log } from '../../../dev/debug.js'
import { notchesFromDelta, scrollLeftAfterZoom, zoomAfterNotches } from '../../store/zoom.js'
import type { AppState, SelectMode } from '../../store/state.js'
import type { ContextMenuState } from '../ContextMenu.js'

/** Trim-handle width, in pixels. Also the hit area. */
export const HANDLE = 8

/**
 * Pull radius, in pixels. Converted at the current zoom so the magnet feels the
 * same at every zoom level.
 */
const SNAP_PIXELS = 10

type Drag =
  | { kind: 'playhead'; locked: SnapTarget | null }
  | {
      kind: 'move'
      lane: Lane
      index: number
      grabOffset: number
      locked: SnapTarget | null
      /** Captured at drag start; see the note where it is built. */
      snapTargets: SnapTarget[]
      /** End-edge-only targets (the next clip's start), also captured once. */
      endSnapTargets: SnapTarget[]
    }
  | { kind: 'trim-in'; lane: Lane; index: number; locked: SnapTarget | null }
  | { kind: 'trim-out'; lane: Lane; index: number; locked: SnapTarget | null }

/** The modifier keys a click can carry. Named, so the signature stays on one
 *  line — an inline object type here is both harder to read and invisible to
 *  the source-level guard in test/dom.test.ts, which has to find this
 *  function's body by scanning for its braces. */
export interface ClickModifiers {
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
}

/**
 * How a click changes the selection.
 *
 * Shift wins over ctrl when both are held: shift means "extend from where I
 * already am", which is the more specific intent of the two.
 */
export function selectModeOf(event: ClickModifiers): SelectMode {
  if (event.shiftKey) return 'range'
  if (event.ctrlKey || event.metaKey) return 'toggle'
  return 'replace'
}

export interface TimelineDrag {
  /** Where the active snap is, for the guide line. */
  guide: Accessor<{ time: number; label: string } | null>
  onPointerDown: (event: PointerEvent) => void
  onPointerMove: (event: PointerEvent) => void
  onPointerUp: () => void
  onContextMenu: (event: MouseEvent) => void
}

export function useTimelineDrag(
  state: AppState,
  menu: ContextMenuState,
  elements: { track: () => HTMLDivElement | undefined; scroller: () => HTMLDivElement | undefined },
): TimelineDrag {
  let drag: Drag | null = null
  /**
   * Whether this gesture has recorded its "before" state in the undo history.
   *
   * A move or trim spans dozens of pointermove events, each writing the lanes.
   * Committing on pointerdown would add a history entry for every plain click
   * that only selects a clip, so the first actual movement is what commits —
   * once — and the per-move writes land inside that single entry.
   */
  let dragCommitted = false
  /** Wheel bursts are summed and applied once per frame. */
  let pendingNotches = 0
  let rafId = 0
  /** True when a ctrl+wheel frame already anchored the scroll on the pointer. */
  let wheelAnchored = false
  /** Pointer X of the most recent wheel event, in client coordinates. */
  let wheelClientX = 0

  const [guide, setGuide] = createSignal<{ time: number; label: string } | null>(null)

  /**
   * The snap targets for the current timeline.
   *
   * Clip edges from both lanes, so a video edge lines up with an audio edge,
   * plus the timeline origin. Collected fresh each time rather than cached: a
   * drag mutates the timeline, and a stale target list is how a snap ends up
   * pointing at a clip that has moved.
   *
   * **The playhead is deliberately not a target.** Snapping is for placing
   * clips; the playhead is for telling time. A playhead that jumps to the
   * nearest edge stops being a measurement and starts being a guess — when you
   * drag it to check what is at 1:14, you want 1:14, not 1:14 snapped to a
   * boundary.
   */
  /**
   * The lanes whose edges are targets for a drag in `lane`.
   *
   * `clipSnap` contributes the dragged clip's own lane (align within a row);
   * `laneSnap` contributes the other one (align picture to sound). The two are
   * independent toggles, so either, both, or neither can be on.
   */
  const enabledLanes = (lane: Lane): Lane[] => {
    const out: Lane[] = []
    if (state.clipSnap()) out.push(lane)
    if (state.laneSnap()) out.push(lane === 'video' ? 'audio' : 'video')
    return out
  }

  const targets = (lane: Lane): SnapTarget[] =>
    collectTargets(state.project, {
      playhead: state.playhead(),
      includePlayhead: false,
      lanes: enabledLanes(lane),
    })

  /**
   * The playhead snaps to every clip edge in both lanes, plus the timeline
   * start. Not lane-filtered: the playhead has no lane of its own, and clip/lane
   * snapping must not decide which points it can land on.
   */
  const playheadTargets = (): SnapTarget[] =>
    collectTargets(state.project, { playhead: state.playhead(), includePlayhead: false })

  const localX = (event: PointerEvent | MouseEvent): number => {
    const el = elements.track()
    return el ? event.clientX - el.getBoundingClientRect().left : 0
  }

  const laneStart = (lane: Lane, index: number): number =>
    clipStart(laneOf(state.project, lane), index)

  /** Index in this lane whose span contains time `t`. */
  function indexAtTime(t: number, lane: Lane): number {
    const loc = clipAtLane(laneOf(state.project, lane), t)
    return loc ? loc.index : 0
  }

  function onPointerDown(event: PointerEvent): void {
    dragCommitted = false
    const target = event.target as HTMLElement
    const lane = target.closest('[data-lane]')?.getAttribute('data-lane') as Lane | undefined
    elements.track()?.setPointerCapture(event.pointerId)

    // Every click positions the playhead, wherever it lands: ruler, empty lane,
    // or on top of a clip. Position first, gesture second — a press is a seek
    // that may turn into a drag, not one or the other.
    const x = localX(event)
    if (state.playing()) state.setPlaying(false)
    state.seek(state.xToTime(x))

    if (target.dataset.handle === 'in' || target.dataset.handle === 'out') {
      if (!lane) return
      const index = Number(target.dataset.index)
      drag = { kind: target.dataset.handle === 'in' ? 'trim-in' : 'trim-out', lane, index, locked: null }
      return
    }

    if (target.dataset.clipIndex !== undefined && lane) {
      const index = Number(target.dataset.clipIndex)
      const clip = laneOf(state.project, lane)[index]
      if (!clip) return
      state.selectClip(clip.id, selectModeOf(event))
      const laneClips = laneOf(state.project, lane)
      const selected = new Set(state.selection())
      // Only *fixed* edges are targets, captured once. The dragged clips move,
      // and so does every clip after the first selected one (positions are
      // derived, so a rightward drag pushes its successors). Their edges travel
      // with the drag, and a target that moves with the clip is a target it
      // chases — the vibration. Selected clips in the other lane move too, so
      // they are excluded as well.
      const moving = movingInLane(laneClips, selected)
      const all = targets(lane)
      let lastSelected = -1
      for (let i = 0; i < laneClips.length; i++) if (selected.has(laneClips[i]!.id)) lastSelected = i
      const next = lastSelected >= 0 ? laneClips[lastSelected + 1] : undefined
      // The one useful downstream snap: the end edge butting the next clip's
      // start. End-only, so the start edge cannot overlap it.
      const butt = next
        ? all.filter((t) => t.lane === lane && t.kind === 'clip-start' && t.clipId === next.id)
        : []
      drag = {
        kind: 'move',
        lane,
        index,
        grabOffset: state.xToTime(x) - laneStart(lane, index),
        locked: null,
        snapTargets: all.filter(
          (t) => !t.clipId || !(selected.has(t.clipId) || (t.lane === lane && moving.has(t.clipId))),
        ),
        endSnapTargets: butt,
      }
      return
    }

    // Ruler or empty lane: a plain seek, and dragging keeps scrubbing. The
    // selection is dropped, because a left click on nothing means "I am done
    // with those clips" — and the next Delete should not take them.
    state.clearSelection()
    drag = { kind: 'playhead', locked: null }
    setGuide(null)
  }

  function onPointerMove(event: PointerEvent): void {
    if (!drag) return
    const x = localX(event)
    const t = state.xToTime(x)

    switch (drag.kind) {
      case 'playhead': {
        // Playhead snapping is its own mode, gated by its own toggle. It pulls
        // to real edit points so the playhead lands on a cut exactly, rather
        // than near it — and it is unaffected by clip or lane snapping.
        let time = t
        if (state.playheadSnap()) {
          const threshold = thresholdInSeconds(SNAP_PIXELS, state.zoom())
          const snapped = snapPlayhead(t, playheadTargets(), threshold, drag.locked)
          if (snapped) {
            time = snapped.time
            drag.locked = snapped.target
            setGuide({ time: snapped.time, label: describeTarget(snapped.target) })
          } else {
            drag.locked = null
            setGuide(null)
          }
        } else {
          drag.locked = null
          setGuide(null)
        }
        state.seek(time)
        return
      }

      case 'move': {
        const clips = laneOf(state.project, drag.lane)
        const clip = clips[drag.index]
        if (!clip) return
        if (!dragCommitted) {
          state.commit()
          dragCommitted = true
        }

        // The pointer position first, then a pull to a nearby edge. Both edges
        // of the clip are candidates, so it can butt its start against a
        // neighbour's end or its end against a neighbour's start. Snapping is
        // gated on the toggle; moving without it is exact.
        const raw = t - drag.grabOffset
        let start = raw
        if (state.snapping()) {
          const threshold = thresholdInSeconds(SNAP_PIXELS, state.zoom())
          const snapped = snapMove(
            raw,
            clipDuration(clip),
            drag.snapTargets,
            threshold,
            undefined,
            drag.locked,
            drag.endSnapTargets,
          )
          if (snapped) {
            start = snapped.start
            drag.locked = snapped.target
            setGuide({ time: snapped.target.time, label: describeTarget(snapped.target) })
          } else {
            drag.locked = null
            setGuide(null)
          }
        } else {
          drag.locked = null
          setGuide(null)
        }

        // A multi-selection moves as one rigid block. It is a different gesture
        // from a single clip: there is no unambiguous neighbour to swap with, so
        // the group only shifts and repacks, it never reorders.
        if (state.selectionCount() > 1) {
          state.moveSelection(drag.lane, drag.index, start)
          return
        }

        const prevEnd = drag.index > 0 ? clipEnd(clips, drag.index - 1) : 0

        if (start < prevEnd - 1e-6) {
          // Moving left far enough to overlap the previous clip. Crossing a
          // neighbour is a SWAP: the clip passes through rather than sticking on
          // the boundary and refusing to go further.
          const target = indexAtTime(start + clipDuration(clip) / 2, drag.lane)
          if (target !== drag.index && target >= 0) {
            state.reorder(drag.lane, drag.index, target)
            drag = { ...drag, index: target }
          }
        } else {
          // Fits after its predecessor, so it is positioned freely. `placeClip`
          // clamps against overlap; that is a collision constraint, not a
          // magnetic pull, and it never attracts toward a target.
          state.place(drag.lane, drag.index, start)
        }

        return
      }

      case 'trim-in':
      case 'trim-out': {
        // THE ONLY SNAPPING IN THE APP. The pull radius is a pixel distance, so
        // it becomes seconds at the current zoom; otherwise the magnet weakens
        // as you zoom in and feels broken at high zoom.
        const threshold = state.snapping() ? thresholdInSeconds(SNAP_PIXELS, state.zoom()) : 0
        const clips = laneOf(state.project, drag.lane)
        const clip = clips[drag.index]
        if (!clip) return
        if (!dragCommitted) {
          state.commit()
          dragCommitted = true
        }

        // Snap in TIMELINE space, then convert to source.
        //
        // These are two different coordinate systems and mixing them is the
        // whole bug: `clip.in` is a position in the source file, while every
        // snap target is a position on the timeline. They coincide only for a
        // fresh clip at time zero. On an already-trimmed clip, or any clip not
        // at the start, comparing a source time against timeline targets pulls
        // the handle toward the wrong place — or nowhere at all.
        //
        // The edge follows the pointer, so its proposed position IS its
        // timeline position.
        const proposed = t
        const snapped =
          threshold > 0
            ? snapTrimEdge(proposed, targets(drag.lane), threshold, { clipId: clip.id }, drag.locked)
            : null

        const laneStartTime = laneStart(drag.lane, drag.index)
        // Either the snapped timeline position or the raw pointer position,
        // expressed as an offset from the clip's own start, then as source time.
        const sourceT = clip.in + ((snapped ? snapped.time : proposed) - laneStartTime)

        if (drag.kind === 'trim-in') state.trim(drag.lane, drag.index, sourceT, clip.out)
        else state.trim(drag.lane, drag.index, clip.in, sourceT)

        drag.locked = snapped?.target ?? null
        setGuide(snapped ? { time: snapped.time, label: describeTarget(snapped.target) } : null)
        return
      }
    }
  }

  function onPointerUp(): void {
    drag = null
    setGuide(null)
  }

  /**
   * Right-click.
   *
   * Selection follows the *target*, not the click: right-clicking a clip that is
   * already part of a multi-selection keeps the whole selection, so the menu can
   * act on all of it. Right-clicking outside the selection narrows to that one
   * clip, which is what makes a right click feel like "act on this".
   */
  function onContextMenu(event: MouseEvent): void {
    event.preventDefault()
    const target = event.target as HTMLElement
    const laneEl = target.closest('[data-lane]')
    const lane = (laneEl?.getAttribute('data-lane') as Lane | null) ?? undefined
    const clipEl = target.closest('[data-clip-index]')

    if (clipEl && lane) {
      const clipId = clipEl.getAttribute('data-clip-id')
      if (!clipId) return
      if (!state.isSelected(clipId)) state.selectClip(clipId, 'replace')
      else state.setPrimary(clipId)
      menu.show({ kind: 'clip', lane, clipId, x: event.clientX, y: event.clientY })
      return
    }

    menu.show({ kind: lane ? 'lane' : 'timeline', lane, x: event.clientX, y: event.clientY })
  }

  /**
   * Ctrl + wheel zooms the timeline, about the pointer.
   *
   * A plain wheel still scrolls, so this does not steal the gesture people
   * already use for panning. A pinch on a trackpad arrives as a ctrl+wheel
   * event, so that works too and needs no special case.
   *
   * Registered as a native non-passive listener rather than JSX `onWheel`,
   * because the only thing this handler must guarantee is that the browser's
   * own page-zoom does not also happen.
   */
  function onWheel(event: WheelEvent): void {
    if (!event.ctrlKey && !event.metaKey) {
      // Plain wheel pans the timeline sideways. The timeline is one screen tall
      // with only two lanes, so it has no vertical overflow to scroll — a plain
      // wheel would otherwise do nothing at all. When there *is* vertical
      // content (a very short timeline panel), the gesture is left native.
      const scroller = elements.scroller()
      if (!scroller) return
      const canPan = scroller.scrollWidth > scroller.clientWidth
      const mustScrollVertically = scroller.scrollHeight > scroller.clientHeight
      if (!canPan || mustScrollVertically) return
      event.preventDefault()
      const step = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY
      scroller.scrollLeft += step + event.deltaX
      return
    }
    // Recorded here because it only exists on the event, and the zoom is
    // applied a frame later.
    wheelClientX = event.clientX
    // Must happen even though the zoom is deferred: this is the browser's own
    // page-zoom gesture, and the event does not wait for an animation frame.
    event.preventDefault()

    pendingNotches += notchesFromDelta(event.deltaY, event.deltaMode)
    if (rafId) return
    rafId = requestAnimationFrame(applyPendingZoom)
  }

  /**
   * Apply the whole burst in one go, once per frame.
   *
   * Wheel events arrive far faster than a frame. Zooming per event meant a
   * trackpad pinch ran dozens of full re-layouts per second — and because each
   * one reads `getBoundingClientRect()` and `scrollLeft` before writing, every
   * event forced a synchronous layout of everything the previous event had just
   * dirtied. That is the difference between zooming and fighting the timeline.
   *
   * Coalescing also makes the *response* faster: a burst collapses to a single
   * jump instead of a queue of work that lags behind the gesture.
   */
  function applyPendingZoom(): void {
    rafId = 0
    const notches = pendingNotches
    pendingNotches = 0
    if (notches === 0) return

    const before = state.zoom()
    const after = zoomAfterNotches(before, notches)
    if (after === before) return

    const scroller = elements.scroller()
    if (!scroller) return
    // Anchor on the pointer: whatever is under the cursor stays under it, so
    // wheeling over a clip zooms *that* clip rather than a fixed spot.
    wheelAnchored = true
    const pointerX = wheelClientX - scroller.getBoundingClientRect().left
    const next = scrollLeftAfterZoom({
      scrollLeft: scroller.scrollLeft,
      localX: pointerX,
      zoomBefore: before,
      zoomAfter: after,
    })
    state.setZoom(after)
    scroller.scrollLeft = Math.max(0, next)
  }

  /**
   * Zoom that did not come from the wheel keeps the viewport centre fixed.
   *
   * The wheel anchors on the pointer (see `applyPendingZoom`); the slider has no
   * pointer position, so the middle of the screen is its natural anchor. Both
   * move the scroll now that the scroller is properly constrained — before, it
   * was as wide as the content and `scrollLeft` could never change at all.
   */
  let prevZoom = state.zoom()
  createEffect(() => {
    const after = state.zoom()
    const before = prevZoom
    prevZoom = after
    if (after === before) return
    if (wheelAnchored) {
      wheelAnchored = false
      return
    }
    const scroller = elements.scroller()
    if (!scroller) return
    const next = scrollLeftAfterZoom({
      scrollLeft: scroller.scrollLeft,
      localX: scroller.clientWidth / 2,
      zoomBefore: before,
      zoomAfter: after,
    })
    scroller.scrollLeft = Math.max(0, next)
  })

  onMount(() => {
    elements.scroller()?.addEventListener('wheel', onWheel, { passive: false })
  })
  onCleanup(() => {
    elements.scroller()?.removeEventListener('wheel', onWheel)
    // A pending frame would otherwise apply a zoom to a component that is gone.
    if (rafId) cancelAnimationFrame(rafId)
  })

  // Referenced so the import is used by the debug channel even when the guides
  // are not drawn; removing the log would lose the snap decision trail.
  void log

  return { guide, onPointerDown, onPointerMove, onPointerUp, onContextMenu }
}
