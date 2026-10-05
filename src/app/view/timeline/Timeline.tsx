/**
 * The timeline: a toolbar, a ruler, and N tracks.
 *
 * This file is layout and composition. Everything with a *decision* in it lives
 * next door: gestures in `use-timeline-drag`, and each region's markup in its
 * own module.
 */

import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import type { TrackId } from '../../../model/project.js'
import type { AppState } from '../../store/state.js'
import type { ContextMenuState } from '../ui/ContextMenu.js'
import { DND_ASSET, draggedAssetId } from '../media/AssetBin.js'
import { Lane as LaneView, type DropPreview } from './Lane.js'
import { Ruler } from './Ruler.js'
import { ticks } from './ticks.js'
import { TimelineScrollbar } from './TimelineScrollbar.js'
import { Toolbar } from './Toolbar.js'
import type { LayoutState } from '../../store/layout.js'
import { useTimelineDrag } from './use-timeline-drag.js'

export function Timeline(props: { state: AppState; menu: ContextMenuState; layout: LayoutState }) {
  const state = props.state
  let trackEl: HTMLDivElement | undefined
  let scrollerEl: HTMLDivElement | undefined

  const [dropAt, setDropAt] = createSignal<DropPreview | null>(null)

  const drag = useTimelineDrag(state, props.menu, {
    track: () => trackEl,
    scroller: () => scrollerEl,
  })

  const [viewportWidth, setViewportWidth] = createSignal(0)
  onMount(() => {
    const el = scrollerEl
    if (!el) return
    const observer = new ResizeObserver(() => setViewportWidth(el.clientWidth))
    observer.observe(el)
    setViewportWidth(el.clientWidth)
    onCleanup(() => observer.disconnect())
  })

  const contentWidth = (): number =>
    Math.max(viewportWidth(), 600, state.timeToX(state.duration()) + 200)

  const anyClips = (): boolean =>
    state.project.tracks.some((t) => t.clips.length > 0)

  // Video on top with the topmost layer first, then audio underneath — how a
  // timeline reads. The model stores video bottom-to-top (the paint order
  // `paintIntentAt` walks), so the display is the reverse of that group.
  const displayTracks = () => {
    const video = state.project.tracks.filter((t) => t.type === 'video')
    const audio = state.project.tracks.filter((t) => t.type === 'audio')
    return [...video].reverse().concat(audio)
  }

  createEffect(() => {
    for (const assetId of state.assetIds()) void state.peaksFor(assetId)
  })

  const trackLeft = (): number => trackEl?.getBoundingClientRect().left ?? 0

  function trackAtClientY(clientY: number): TrackId {
    const tracks: { trackId: TrackId; mid: number }[] = state.project.tracks.map((t) => {
      const el = trackEl?.querySelector(`[data-track="${t.id}"]`)
      const r = el?.getBoundingClientRect()
      return { trackId: t.id, mid: r ? r.top + r.height / 2 : 0 }
    })
    return tracks.reduce((best, cur) =>
      Math.abs(cur.mid - clientY) < Math.abs(best.mid - clientY) ? cur : best,
    ).trackId
  }

  const timeAtClientX = (clientX: number): number => state.xToTime(clientX - trackLeft())

  function targetTrack(assetId: string, clientY: number): TrackId {
    const nearest = trackAtClientY(clientY)
    if (state.trackAccepts(assetId, nearest)) return nearest
    const fallback = state.project.tracks.find((t) => state.trackAccepts(assetId, t.id))
    return fallback?.id ?? nearest
  }

  const modeFor = (event: DragEvent): 'overwrite' | 'insert' => (event.shiftKey ? 'insert' : 'overwrite')

  const carriesFiles = (event: DragEvent): boolean =>
    Array.from(event.dataTransfer?.types ?? []).includes('Files')

  function onDragOverTrack(event: DragEvent): void {
    const dt = event.dataTransfer
    if (!dt) return
    const internal = dt.types.includes(DND_ASSET)

    if (!internal && !carriesFiles(event)) return
    event.preventDefault()

    const mode = modeFor(event)
    dt.dropEffect = mode === 'insert' ? 'copy' : 'move'

    if (internal) {
      const assetId = dt.getData(DND_ASSET) || draggedAssetId()
      if (!assetId) return
      const trackId = targetTrack(assetId, event.clientY)
      setDropAt({
        trackId,
        time: state.dropTimeFor(timeAtClientX(event.clientX), trackId),
        duration: state.getAsset(assetId)?.duration ?? 0,
        assetId,
        mode,
      })
    } else {
      const trackId = trackAtClientY(event.clientY)
      setDropAt({
        trackId,
        time: state.dropTimeFor(timeAtClientX(event.clientX), trackId),
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
    setDropAt(null)

    const assetId = dt.getData(DND_ASSET) || draggedAssetId()
    if (assetId) {
      event.preventDefault()
      const trackId = targetTrack(assetId, event.clientY)
      const time = state.dropTimeFor(timeAtClientX(event.clientX), trackId)
      event.stopPropagation()
      state.addAssetAt(assetId, trackId, time, mode)
      return
    }

    const files = [...(dt.files ?? [])]
    if (files.length > 0) {
      event.preventDefault()
      event.stopPropagation()
      const trackId = trackAtClientY(event.clientY)
      const time = state.dropTimeFor(timeAtClientX(event.clientX), trackId)
      void state.dropFiles(files, trackId, time, mode)
    }
  }

  return (
    <section class="flex min-h-0 min-w-0 flex-1 flex-col border-t border-line bg-panel">
      <Toolbar state={state} anyClips={anyClips} layout={props.layout} />

      <div ref={scrollerEl} class="min-h-0 w-full min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div
          ref={trackEl}
          id="timeline-track"
          class="relative min-h-full select-none touch-none"
          style={{ width: `${contentWidth()}px` }}
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

          <div class="pointer-events-none absolute inset-x-0 bottom-0 top-6 z-0">
            <For each={ticks(state.duration(), state.zoom())}>
              {(t) => <div class="absolute bottom-0 top-0 w-px bg-line-soft" style={{ left: `${state.timeToX(t)}px` }} />}
            </For>
          </div>

          <For each={displayTracks()}>
            {(track) => (
              <LaneView
                trackId={track.id}
                type={track.type}
                label={track.type}
                state={state}
                height={track.type === 'video' ? 56 : 62}
                dropAt={dropAt}
                setDropAt={setDropAt}
                trackLeft={trackLeft}
                canRemove={track.clips.length === 0 && state.project.tracks.length > 1}
                onRemove={() => state.removeTrack(track.id)}
              />
            )}
          </For>

          <Show when={!anyClips()}>
            <p class="pointer-events-none absolute inset-x-0 top-16 text-center text-mini text-muted">
              Double-click a file in Media, or drag one onto a track.
            </p>
          </Show>

          <Show when={drag.guide()}>
            {(g) => (
              <div
                class="pointer-events-none absolute bottom-0 top-0 z-30 w-px bg-warn"
                style={{ left: `${state.timeToX(g().time)}px` }}
              >
                <span class="absolute -top-px left-1 rounded bg-warn px-1 text-micro font-semibold text-black">
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

      <TimelineScrollbar scroller={() => scrollerEl} contentWidth={contentWidth} />
    </section>
  )
}
