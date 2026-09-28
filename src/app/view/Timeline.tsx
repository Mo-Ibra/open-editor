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

import { createEffect, createSignal, Show } from 'solid-js'
import type { Lane } from '../../model/project.js'
import type { AppState } from '../store/state.js'
import type { ContextMenuState } from './ContextMenu.js'
import { Lane as LaneView } from './timeline/Lane.js'
import { Ruler } from './timeline/Ruler.js'
import { Toolbar } from './timeline/Toolbar.js'
import { useTimelineDrag } from './timeline/use-timeline-drag.js'

export function Timeline(props: { state: AppState; menu: ContextMenuState }) {
  const state = props.state
  let trackEl: HTMLDivElement | undefined
  let scrollerEl: HTMLDivElement | undefined

  /** Where a dragged file would land, while a drag is over the timeline. */
  const [dropAt, setDropAt] = createSignal<{ lane: Lane; time: number } | null>(null)

  const drag = useTimelineDrag(state, props.menu, {
    track: () => trackEl,
    scroller: () => scrollerEl,
  })

  /** The track is at least this wide, so an empty timeline is still grabbable. */
  const contentWidth = (): number => Math.max(600, state.timeToX(state.duration()) + 200)

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

  return (
    <section class="flex h-[236px] shrink-0 flex-col border-t border-line bg-panel">
      <Toolbar state={state} anyClips={anyClips} />

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
          onPointerMove={drag.onPointerMove}
          onPointerUp={drag.onPointerUp}
          onPointerCancel={drag.onPointerUp}
        >
          <Ruler state={state} />

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
