/**
 * The timeline: two lanes, with a waveform on the audio one.
 *
 * Clip x-positions come from the *derived* start, never a stored value, so a
 * clip cannot drift out of order however it was edited (docs/data-model.md).
 *
 * The lanes are the whole reason the model has two. Trimming the picture
 * while keeping the sound, or cutting a voiceover with no picture, are ordinary
 * things to want and neither is expressible with a single fused clip. Linked
 * pairs edit together by default; breaking the link is one click.
 */

import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { clipAtLane, clipDuration, clipEnd, clipStart, laneOf, type Clip, type Lane } from '../model/project.js'
import { drawPeaks, type Peak } from '../media/peaks.js'
import {
  collectTargets,
  describeTarget,
  snapTrimEdge,
  thresholdInSeconds,
  type SnapTarget,
} from '../model/snapping.js'
import type { AppState, SelectMode } from '../app/state.js'
import type { ContextMenuState } from './ContextMenu.js'
import { DND_ASSET } from './AssetBin.js'
import { notchesFromDelta, scrollLeftAfterZoom, zoomAfterNotches } from '../app/zoom.js'
import { log } from '../dev/debug.js'

const HANDLE = 8

/**
 * `locked` — the latched snap target — exists on the trim variants ONLY.
 *
 * That is the whole architectural statement, expressed in the type: moving a
 * clip is not physically capable of latching onto a target, so the compiler
 * rejects a move that tries.
 */
type Drag =
  | { kind: 'playhead' }
  | { kind: 'move'; lane: Lane; index: number; grabOffset: number }
  | { kind: 'trim-in'; lane: Lane; index: number; locked: SnapTarget | null }
  | { kind: 'trim-out'; lane: Lane; index: number; locked: SnapTarget | null }

export function Timeline(props: { state: AppState; menu: ContextMenuState }) {
  const state = props.state
  let track!: HTMLDivElement
  let scroller!: HTMLDivElement
  /** Wheel bursts are summed and applied once per frame. */
  let pendingNotches = 0
  let rafId = 0
  /** Pointer X of the most recent wheel event, in client coordinates. */
  let wheelClientX = 0

  let drag: Drag | null = null
  const [guide, setGuide] = createSignal<{ time: number; label: string } | null>(null)
  /** Where a dragged file would land, while a drag is over the timeline. */
  const [dropAt, setDropAt] = createSignal<{ lane: Lane; time: number } | null>(null)

/** Pull radius, in pixels. Converted at the current zoom so the magnet feels
 *  the same at every zoom level. */
const SNAP_PIXELS = 10

/**
 * The snap targets for the current timeline.
 *
 * Clip edges from both lanes, so a video edge lines up with an audio edge, plus
 * the timeline origin. Collected fresh each time rather than cached: a drag
 * mutates the timeline, and a stale target list is how a snap ends up pointing
 * at a clip that has moved.
 *
 * **The playhead is deliberately not a target.** Snapping is for placing clips;
 * the playhead is for telling time. A playhead that jumps to the nearest edge
 * stops being a measurement and starts being a guess — when you drag it to
 * check what is at 1:14, you want 1:14, not 1:14.00 snapped to a boundary.
 */
/**
 * How a click changes the selection.
 *
 * Shift wins over ctrl when both are held: shift means "extend from where I
 * already am", which is the more specific intent of the two.
 */
function selectModeOf(event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }): SelectMode {
  if (event.shiftKey) return 'range'
  if (event.ctrlKey || event.metaKey) return 'toggle'
  return 'replace'
}

function targets(): SnapTarget[] {
  return collectTargets(state.project, {
    playhead: state.playhead(),
    includePlayhead: false,
  })
}


  const contentWidth = () => Math.max(600, state.timeToX(state.duration()) + 200)

  function localX(event: PointerEvent | MouseEvent): number {
    return event.clientX - track.getBoundingClientRect().left
  }

  /** Origin of the (scrolled) track, for drop coordinates. */
  function trackLeft(): number {
    return track.getBoundingClientRect().left
  }

  function laneStart(lane: Lane, index: number): number {
    return clipStart(laneOf(state.project, lane), index)
  }

  function onPointerDown(event: PointerEvent): void {
    const target = event.target as HTMLElement
    const lane = target.closest('[data-lane]')?.getAttribute('data-lane') as Lane | undefined
    track.setPointerCapture(event.pointerId)

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
      drag = { kind: 'move', lane, index, grabOffset: state.xToTime(x) - laneStart(lane, index) }
      return
    }

    // Ruler or empty lane: a plain seek, and dragging keeps scrubbing. The
    // selection is dropped, because a left click on nothing means "I am done
    // with those clips" — and the next Delete should not take them.
    state.clearSelection()
    drag = { kind: 'playhead' }
    setGuide(null)
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
    if (!event.ctrlKey && !event.metaKey) return
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
   * event forced a synchronous layout of everything the previous event had
   * just dirtied. That is the difference between zooming and fighting the
   * timeline.
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

    // Pointer position inside the visible area. Read once per frame, before any
    // write, so this never forces a layout mid-burst.
    const localX = wheelClientX - scroller.getBoundingClientRect().left
    const nextScroll = scrollLeftAfterZoom({
      scrollLeft: scroller.scrollLeft,
      localX,
      zoomBefore: before,
      zoomAfter: after,
    })

    state.setZoom(after)
    scroller.scrollLeft = Math.max(0, nextScroll)
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
      props.menu.show({ kind: 'clip', lane, clipId, x: event.clientX, y: event.clientY })
      return
    }

    props.menu.show({ kind: lane ? 'lane' : 'timeline', lane, x: event.clientX, y: event.clientY })
  }

  function onPointerMove(event: PointerEvent): void {
    if (!drag) return
    const x = localX(event)
    const t = state.xToTime(x)

    switch (drag.kind) {
      case 'playhead': {
        // No snapping. The playhead goes exactly where the pointer is.
        state.seek(t)
        return
      }

      case 'move': {
        const clips = laneOf(state.project, drag.lane)
        if (!clips[drag.index]) return

        // FREE MOVEMENT. No snapping, no target list, no latch, no guide line.
        // The clip goes exactly where the pointer says.
        const start = t - drag.grabOffset
        const prevEnd = drag.index > 0 ? clipEnd(clips, drag.index - 1) : 0

        if (start < prevEnd - 1e-6) {
          // Moving left far enough to overlap the previous clip. Crossing a
          // neighbour is a SWAP, not a magnet: the clip passes through rather
          // than sticking on the boundary and refusing to go further.
          const target = indexAtTime(start + clipDuration(clips[drag.index]!) / 2, drag.lane)
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

        setGuide(null)
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
            ? snapTrimEdge(proposed, targets(), threshold, { clipId: clip.id }, drag.locked)
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

  /** Index in this lane whose span contains time `t`. */
  function indexAtTime(t: number, lane: Lane): number {
    const loc = clipAtLane(laneOf(state.project, lane), t)
    return loc ? loc.index : 0
  }

  function onPointerUp(): void {
    drag = null
    setGuide(null)
  }

  // Native, non-passive: `preventDefault` in the handler is the whole point, and
  // a passive listener would let the browser page-zoom underneath us.
  onMount(() => {
    scroller.addEventListener('wheel', onWheel, { passive: false })
  })
  onCleanup(() => {
    scroller.removeEventListener('wheel', onWheel)
    // A pending frame would otherwise apply a zoom to a component that is gone.
    if (rafId) cancelAnimationFrame(rafId)
  })

  /** How many clips are selected, for labels that name their own count. */
  const count = (): number => state.selectionCount()

  /** Tick spacing that stays readable at any zoom. */
  const MIN_GAP = 90
  const TICK_INTERVALS = [0.04, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800]
  function ticks(): number[] {
    const total = state.duration()
    if (total <= 0) return []
    const step = TICK_INTERVALS.find((i) => i * state.zoom() >= MIN_GAP) ?? TICK_INTERVALS.at(-1)!
    const out: number[] = []
    for (let t = 0; t <= total + 1e-9; t += step) out.push(Number(t.toFixed(4)))
    return out
  }

  // Kick off peak computation for every audio-bearing clip, so the waveform is
  // there by the time anyone looks at it.
  createEffect(() => {
    for (const clip of state.project.audio) {
      void state.peaksFor(clip.assetId)
    }
  })

  return (
    <section class="flex h-[236px] shrink-0 flex-col border-t border-line bg-panel">
      {/* toolbar */}
      <div class="flex h-9 shrink-0 items-center gap-1.5 border-b border-line-soft px-2">
        <button class="btn" onClick={() => state.splitAt(state.playhead())} disabled={!anyClips()}>
          Split
        </button>
        <button
          class="btn"
          onClick={() => state.duplicateSelected()}
          disabled={count() === 0}
          title="Copy the selection. A linked pair is copied as a pair (Ctrl+D)"
        >
          {count() > 1 ? `Duplicate ${count()}` : 'Duplicate'}
        </button>
        <button
          class="btn"
          onClick={() => state.deleteSelected()}
          disabled={count() === 0}
          title="Delete the selection. Only selected clips go — not their pairs"
        >
          {count() > 1 ? `Delete ${count()}` : 'Delete'}
        </button>
        <button
          class="btn"
          disabled={!state.selectionHasLinks()}
          onClick={() => state.breakSelectedLinks()}
          title="Cut these clips and their pairs apart, so they edit independently"
        >
          {state.selectionHasLinks() ? 'Break link' : 'unlinked'}
        </button>

        {/* A multi-selection is easy to miss when the clips are small or in
            different lanes, so the toolbar states the number outright rather
            than making the user count rings. */}
        <Show when={count() > 1}>
          <span class="rounded-full border border-accent/50 bg-accent/15 px-2 py-0.5 text-[10.5px] font-semibold text-accent">
            {count()} clips selected
          </span>
        </Show>

        <span class="mx-1 h-5 w-px bg-line" />

        <button
          class="btn"
          classList={{ '!border-accent/50 !text-accent': state.snapping() }}
          disabled={!anyClips()}
          onClick={() => state.setSnapping(!state.snapping())}
          title="Magnetic snapping: align clip edges, the playhead, and the timeline start (G)"
        >
          <MagnetIcon on={state.snapping()} />
          snap
        </button>

        <Show when={state.selectedClip()}>
          {(clip) => (
            <Show when={clip().lane === 'audio'}>
              <label class="flex items-center gap-2 text-[10.5px] text-muted">
                level
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.01"
                  class="w-24"
                  value={clip().gain ?? 1}
                  onInput={(e) => state.setClipGain(clip().id, Number(e.currentTarget.value))}
                />
                <span class="timecode w-8">{Math.round((clip().gain ?? 1) * 100)}%</span>
                <button class="btn !py-0.5" onClick={() => state.toggleMute(clip().id)}>
                  {clip().muted ? 'muted' : 'live'}
                </button>
              </label>
            </Show>
          )}
        </Show>

        <span class="flex-1" />

        <span class="timecode pr-1 text-[10.5px] text-muted">
          {state.project.video.length} video · {state.project.audio.length} audio
        </span>
      </div>

      {/* ruler + lanes */}
      <div ref={scroller} class="min-h-0 flex-1 overflow-auto">
        <div
          ref={track}
          class="relative min-h-full select-none touch-none"
          style={{ width: `${contentWidth()}px` }}
          // The zoom, exactly. The preview's slider is `step="10"`, so it can
          // only report multiples of ten and cannot be used to read a precise
          // zoom level — which makes this the only exact readout, and the only
          // way a test can verify the pointer anchor.
          data-zoom={state.zoom()}
          onPointerDown={onPointerDown}
          onContextMenu={onContextMenu}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div class="sticky top-0 h-6 border-b border-line bg-raised/80 backdrop-blur">
            <For each={ticks()}>
              {(tick) => (
                <span
                  class="absolute top-0 h-full border-l border-line pl-1.5 pt-1 timecode text-[9.5px] text-muted"
                  style={{ left: `${state.timeToX(tick)}px` }}
                >
                  {formatTick(tick)}
                </span>
              )}
            </For>
          </div>

          <LaneView lane="video" label="video" state={state} height={56}
            setDropAt={setDropAt} isDropTarget={() => dropAt()?.lane === 'video'}
            xToTime={state.xToTime} trackLeft={trackLeft} />
          <LaneView lane="audio" label="audio" state={state} height={62}
            setDropAt={setDropAt} isDropTarget={() => dropAt()?.lane === 'audio'}
            xToTime={state.xToTime} trackLeft={trackLeft} />

          <Show when={!anyClips()}>
            <p class="pointer-events-none absolute inset-x-0 top-16 text-center text-[11.5px] text-muted">
              Click a file in Media to add it here.
            </p>
          </Show>

          {/* Where a dragged file would land. */}
          <Show when={dropAt()}>
            {(at) => (
              <div
                class="pointer-events-none absolute bottom-0 top-0 z-30 w-0.5 bg-accent"
                style={{ left: `${state.timeToX(at().time)}px` }}
              >
                <span class="absolute -top-px left-1 rounded bg-accent px-1 text-[9px] font-semibold text-black">
                  drop into {at().lane}
                </span>
              </div>
            )}
          </Show>

          {/* The guide makes the magnet legible. A snap you cannot see is a
              snap the user cannot trust, so the reason is labelled. */}
          <Show when={guide()}>
            {(g) => (
              <div
                class="pointer-events-none absolute bottom-0 top-0 z-30 w-px bg-warn"
                style={{ left: `${state.timeToX(g().time)}px` }}
              >
                <span class="absolute -top-px left-1 rounded bg-warn px-1 text-[9px] font-semibold text-black">
                  {g().label}
                </span>
              </div>
            )}
          </Show>

          <div
            class="pointer-events-none absolute bottom-0 top-0 z-20 w-px bg-accent"
            style={{ left: `${state.timeToX(state.playhead())}px` }}
          >
            <span class="absolute -left-[5px] top-0 border-x-[5px] border-t-[6px] border-x-transparent border-t-accent" />
          </div>
        </div>
      </div>
    </section>
  )

  function anyClips(): boolean {
    return state.project.video.length > 0 || state.project.audio.length > 0
  }
}

function LaneView(props: {
  lane: Lane
  label: string
  state: AppState
  height: number
  setDropAt: (value: { lane: Lane; time: number } | null) => void
  isDropTarget: () => boolean
  xToTime: (x: number) => number
  trackLeft: () => number
}) {
  const state = props.state
  const clips = () => laneOf(state.project, props.lane)

  function onDragOver(event: DragEvent): void {
    // Without preventDefault the browser refuses the drop outright.
    if (!event.dataTransfer?.types.includes(DND_ASSET)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    props.setDropAt({ lane: props.lane, time: props.xToTime(event.clientX - props.trackLeft()) })
  }

  function onDrop(event: DragEvent): void {
    const assetId = event.dataTransfer?.getData(DND_ASSET)
    if (!assetId) return
    event.preventDefault()
    state.addAssetAt(assetId, props.lane, props.xToTime(event.clientX - props.trackLeft()))
    props.setDropAt(null)
  }

  return (
    <div
      class="relative border-b border-line-soft last:border-b-0"
      classList={{ 'ring-1 ring-inset ring-accent/60': props.isDropTarget?.() }}
      data-lane={props.lane}
      style={{ height: `${props.height}px` }}
      onDragOver={onDragOver}
      onDragLeave={() => props.setDropAt(null)}
      onDrop={onDrop}
    >
      <span class="panel-label pointer-events-none absolute right-2 top-1.5 z-10">{props.label}</span>
      <For each={clips()}>
        {(clip, index) => (
          <ClipView clip={clip} index={index()} state={state} lane={props.lane} height={props.height - 12} />
        )}
      </For>
    </div>
  )
}

function ClipView(props: { clip: Clip; index: number; state: AppState; lane: Lane; height: number }) {
  const state = props.state
  const rect = () => state.clipRect(props.lane, props.index)
  const asset = () => state.getAsset(props.clip.assetId)
  const isSelected = () => state.isSelected(props.clip.id)
  const isPrimary = () => state.primary() === props.clip.id
  const linked = () => (props.clip.linkId ? state.selectedPartner()?.linkId === props.clip.linkId : false)

  return (
    <div
      class="group absolute top-1.5 cursor-grab overflow-hidden rounded-md border transition-shadow active:cursor-grabbing"
      classList={{
        selected: isSelected(),
        // Every selected clip gets a solid accent ring, so a multi-selection is
        // unmistakable at a glance. The primary clip additionally gets a white
        // ring, which is how you tell which one a solo action will hit.
        //
        // Solid colours via ring utilities. An opacity modifier written inside
        // an arbitrary shadow value is compiled by Tailwind into an opacity
        // applied to a var() reference, which is invalid CSS and silently drops
        // the whole box-shadow — the class exists, the ring does not. That is
        // why a multi-selection used to look like a single selected clip.
        //
        // (Written without a literal class name on purpose: Tailwind scans
        // comments too, so "here is the broken class" in a comment is enough to
        // generate it.)
        'ring-2 ring-accent': isSelected() && !isPrimary(),
        'ring-2 ring-accent ring-offset-1 ring-offset-[#0b0b0e]': isPrimary(),
        'border-transparent': !isSelected(),
      }}
      data-clip-index={props.index}
      data-clip-id={props.clip.id}
      style={{
        left: `${rect().left}px`,
        width: `${Math.max(2, rect().width)}px`,
        height: `${props.height}px`,
        // Tint is a low-chroma wash; the waveform and the picture carry the colour.
        'background-color': props.lane === 'video' ? '#1b2c47' : '#16342a',
        'border-color': isSelected()
          ? 'transparent'
          : props.lane === 'video'
            ? '#2a4674'
            : '#1f5541',
      }}
      title={`${asset()?.name ?? 'missing'} — ${props.clip.in.toFixed(2)}s → ${props.clip.out.toFixed(2)}s`}
    >
      {/* A tick on every selected clip but the primary, so a group selection
          reads as a group even when the rings are only a couple of pixels. */}
      <Show when={isSelected() && !isPrimary()}>
        <span
          class="pointer-events-none absolute left-1 top-1 z-30 flex size-3.5 items-center justify-center rounded-full bg-accent text-[9px] font-bold text-black"
          aria-label="selected"
        >
          ✓
        </span>
      </Show>

      {/* Muting is invisible on a waveform otherwise: the peaks just get
          dimmer, which reads as "quieter", not "muted". */}
      <Show when={props.clip.muted && props.lane === 'audio'}>
        <span
          class="pointer-events-none absolute right-1 top-1 z-30 rounded bg-[#d29922] px-1 text-[9px] font-bold uppercase text-black"
          aria-label="muted"
        >
          mute
        </span>
      </Show>

      <div
        class="absolute inset-y-0 left-0 z-20 cursor-ew-resize bg-white/0 transition-colors group-hover:bg-white/10"
        style={{ width: `${HANDLE}px` }}
        data-handle="in"
        data-index={props.index}
      />

      <Show when={props.lane === 'audio'}>
        <Waveform clip={props.clip} state={state} />
      </Show>

      <span class="pointer-events-none absolute left-2 top-1 z-10 max-w-[calc(100%-34px)] truncate text-[10.5px] text-fg/90 [text-shadow:0_1px_2px_#000a]">
        {asset()?.name ?? '?'}
      </span>

      <Show when={linked()}>
        <span
          class="pointer-events-none absolute right-1.5 top-0.5 z-10 text-[9px] text-fg/60"
          title="Linked to its pair — edits apply to both"
        >
          ⛓
        </span>
      </Show>

      <div
        class="absolute inset-y-0 right-0 z-20 cursor-ew-resize bg-white/0 transition-colors group-hover:bg-white/10"
        style={{ width: `${HANDLE}px` }}
        data-handle="out"
        data-index={props.index}
      />
    </div>
  )
}

/**
 * The waveform.
 *
 * Peaks are computed once per asset and cached in the store; this only draws.
 * It redraws on zoom and on resize, never per frame — a canvas repaint per
 * playhead move would make scrubbing feel like wading.
 */
function Waveform(props: { clip: Clip; state: AppState }) {
  const state = props.state
  let canvas!: HTMLCanvasElement

  const peaks = (): Peak[] | undefined => state.peaksBy[props.clip.assetId]

  function paint(): void {
    const list = peaks()
    if (!list || !canvas) return
    const width = Math.max(1, Math.round(rectWidth()))
    const height = Math.max(1, Math.round(canvas.clientHeight || 40))

    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, width, height)
    drawPeaks(ctx, list, state.getAsset(props.clip.assetId)?.duration ?? 1, {
      startTime: props.clip.in,
      endTime: props.clip.out,
      width,
      height,
      color: props.clip.muted ? 'rgba(210,153,34,0.55)' : 'rgba(255,255,255,0.85)',
    })
  }

  function rectWidth(): number {
    return Math.max(1, props.clip.out - props.clip.in) * state.zoom()
  }

  onMount(paint)
  // Re-paint when the peaks arrive, the clip is trimmed, or the zoom changes.
  createEffect(() => {
    peaks()
    props.clip.in
    props.clip.out
    props.clip.muted
    state.zoom()
    paint()
  })

  return <canvas ref={canvas} class="pointer-events-none absolute inset-0 size-full" style={{ width: `${rectWidth()}px` }} />
}

function formatTick(t: number): string {
  if (t < 1) return `${t.toFixed(t < 0.25 ? 2 : 1)}s`
  const m = Math.floor(t / 60)
  const s = Math.round(t % 60)
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`
}

void log

function MagnetIcon(props: { on: boolean }) {
  return (
    <svg viewBox="0 0 16 16" class="size-3.5" fill="none" stroke="currentColor" stroke-width="1.4">
      <path d="M4 3v5a4 4 0 0 0 8 0V3" stroke-linecap="round" />
      <path d="M2.5 3h3M10.5 3h3" stroke-linecap="round" opacity={props.on ? 1 : 0.35} />
      <path d="M4 3h3v5M9 3h3" stroke-linecap="round" opacity={props.on ? 1 : 0.35} />
    </svg>
  )
}
