/**
 * The timeline: a toolbar, a ruler, and two lanes.
 *
 * This file is layout and composition. Everything with a *decision* in it lives
 * next door: gestures in `use-timeline-drag`, and each region's markup in its
 * own module. What is left is worth being able to read in one screen, because
 * it is the only place that knows how the pieces stack.
 *
 * Clip x-positions come from the *derived* start, never a stored value, so a
 * clip cannot drift out of order however it was edited (docs/data-model.md).
 */

import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js'
import type { Lane } from '../../model/project.js'
import type { AppState } from '../store/state.js'
import type { ContextMenuState } from './ContextMenu.js'
import { DND_ASSET, draggedAssetId } from './AssetBin.js'
import { Lane as LaneView, type DropPreview } from './timeline/Lane.js'
import { Ruler } from './timeline/Ruler.js'
import { Toolbar } from './timeline/Toolbar.js'
import type { LayoutState } from '../store/layout.js'
import { useTimelineDrag } from './timeline/use-timeline-drag.js'

/** Lane row heights, in pixels. The drop target has to agree with what is drawn. */
const LANE_HEIGHTS = [
  ['video', 56],
  ['audio', 62],
] as const satisfies readonly (readonly [Lane, number])[]

export function Timeline(props: { state: AppState; menu: ContextMenuState; layout: LayoutState }) {
  const state = props.state
  let trackEl: HTMLDivElement | undefined
  let scrollerEl: HTMLDivElement | undefined

  /** Where a dragged file would land, while a drag is over the timeline. */
  const [dropAt, setDropAt] = createSignal<DropPreview | null>(null)

  const drag = useTimelineDrag(state, props.menu, {
    track: () => trackEl,
    scroller: () => scrollerEl,
  })

  /**
   * The scroller's own width, tracked so the track can fill it.
   *
   * Without this the track was a flat 600px (or the timeline's length), so an
   * empty or short timeline showed lanes that stopped two thirds of the way
   * across the window — the empty half read as a layout bug, because it was one.
   */
  const [viewportWidth, setViewportWidth] = createSignal(0)
  onMount(() => {
    const el = scrollerEl
    if (!el) return
    const observer = new ResizeObserver(() => setViewportWidth(el.clientWidth))
    observer.observe(el)
    setViewportWidth(el.clientWidth)
    onCleanup(() => observer.disconnect())
  })

  /** The track fills the viewport, and grows past it once the timeline is long. */
  const contentWidth = (): number =>
    Math.max(viewportWidth(), 600, state.timeToX(state.duration()) + 200)

  const anyClips = (): boolean =>
    state.project.video.length > 0 || state.project.audio.length > 0

  // Kick off peak computation for every audio-bearing clip, so the waveform is
  // there by the time anyone looks at it.
  createEffect(() => {
    for (const clip of state.project.audio) {
      void state.peaksFor(clip.assetId)
    }
  })

  const trackLeft = (): number => trackEl?.getBoundingClientRect().left ?? 0

  /**
   * Which lane is a drop at `clientY` aimed at?
   *
   * The lanes do not fill the timeline — there is ruler above and a strip below,
   * and dropping on either used to do nothing at all. So the whole track is a
   * target, and the lane is chosen by proximity: nearest above, otherwise
   * nearest below. "Whatever is closest" is how every editor resolves a drop
   * that lands between tracks, and it removes the need to aim at a 56px strip.
   */
  function laneAtClientY(clientY: number): Lane {
    const lanes: { lane: Lane; mid: number }[] = LANE_HEIGHTS.map(([lane]) => {
      const el = trackEl?.querySelector(`[data-lane="${lane}"]`)
      const r = el?.getBoundingClientRect()
      return { lane, mid: r ? r.top + r.height / 2 : 0 }
    })
    return lanes.reduce((best, cur) =>
      Math.abs(cur.mid - clientY) < Math.abs(best.mid - clientY) ? cur : best,
    ).lane
  }

  const timeAtClientX = (clientX: number): number => state.xToTime(clientX - trackLeft())

  /** Which lane would take this file? The one it can go on, nearest the pointer. */
  function targetLane(assetId: string, clientY: number): Lane {
    const nearest = laneAtClientY(clientY)
    if (state.laneAccepts(assetId, nearest)) return nearest
    return nearest === 'video' ? 'audio' : 'video'
  }

  const modeFor = (event: DragEvent): 'overwrite' | 'insert' => (event.shiftKey ? 'insert' : 'overwrite')

  /** Does this drag carry a file we could import, rather than a known asset? */
  const carriesFiles = (event: DragEvent): boolean =>
    Array.from(event.dataTransfer?.types ?? []).includes('Files')

  function onDragOverTrack(event: DragEvent): void {
    const dt = event.dataTransfer
    if (!dt) return
    const internal = dt.types.includes(DND_ASSET)

    // A file dragged in from the desktop is a legitimate drop, and the common
    // one. It cannot be previewed before it is decoded, so the cue falls back to
    // a fixed width and the real extent appears on landing.
    if (!internal && !carriesFiles(event)) return
    event.preventDefault()

    const mode = modeFor(event)
    dt.dropEffect = mode === 'insert' ? 'copy' : 'move'
    const time = state.dropTimeFor(timeAtClientX(event.clientX))

    if (internal) {
      // `getData` is empty during `dragover` where protected mode is enforced,
      // so fall back to the id captured at `dragstart`.
      const assetId = dt.getData(DND_ASSET) || draggedAssetId()
      if (!assetId) return
      setDropAt({
        lane: targetLane(assetId, event.clientY),
        time,
        duration: state.getAsset(assetId)?.duration ?? 0,
        assetId,
        mode,
      })
    } else {
      setDropAt({
        lane: laneAtClientY(event.clientY),
        time,
        duration: 0,
        assetId: '',
        mode,
        incoming: true,
      })
    }
  }

  function onDropTrack(event: DragEvent): void {
    const dt = event.dataTransfer
    if (!dt) return
    const mode = modeFor(event)
    const time = state.dropTimeFor(timeAtClientX(event.clientX))
    setDropAt(null)

    const assetId = dt.getData(DND_ASSET) || draggedAssetId()
    if (assetId) {
      event.preventDefault()
      state.addAssetAt(assetId, targetLane(assetId, event.clientY), time, mode)
      return
    }

    const files = [...(dt.files ?? [])]
    if (files.length > 0) {
      event.preventDefault()
      // Import *and* place, in one gesture. Importing alone left the file
      // sitting in the bin, which is not what dropping a file on a timeline
      // means anywhere else.
      void state.dropFiles(files, laneAtClientY(event.clientY), time, mode)
    }
  }

  return (
    <section class="flex min-h-0 flex-1 flex-col border-t border-line bg-panel">
      <Toolbar state={state} anyClips={anyClips} layout={props.layout} />

      {/* ruler + lanes */}
      <div ref={scrollerEl} class="min-h-0 flex-1 overflow-auto">
        <div
          ref={trackEl}
          class="relative min-h-full select-none touch-none"
          style={{ width: `${contentWidth()}px` }}
          // The zoom, exactly. The preview's slider is `step="10"`, so it can
          // only report multiples of ten and cannot be used to read a precise
          // zoom level — which makes this the only exact readout, and the only
          // way a test can verify the pointer anchor.
          data-zoom={state.zoom()}
          onPointerDown={drag.onPointerDown}
          onContextMenu={drag.onContextMenu}
          onDragOver={onDragOverTrack}
          onDrop={onDropTrack}
          onPointerMove={drag.onPointerMove}
          onPointerUp={drag.onPointerUp}
          onPointerCancel={drag.onPointerUp}
        >
          <Ruler state={state} onDrop={onDropTrack} onDragOver={onDragOverTrack} />

          <LaneView
            lane="video"
            label="video"
            state={state}
            height={56}
            dropAt={dropAt}
            setDropAt={setDropAt}
            trackLeft={trackLeft}
          />
          <LaneView
            lane="audio"
            label="audio"
            state={state}
            height={62}
            dropAt={dropAt}
            setDropAt={setDropAt}
            trackLeft={trackLeft}
          />

          <Show when={!anyClips()}>
            <p class="pointer-events-none absolute inset-x-0 top-16 text-center text-[11.5px] text-muted">
              Double-click a file in Media, or drag one onto a lane.
            </p>
          </Show>

          {/* The guide makes the magnet legible. A snap you cannot see is a
              snap the user cannot trust, so the reason is labelled. */}
          <Show when={drag.guide()}>
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
}
