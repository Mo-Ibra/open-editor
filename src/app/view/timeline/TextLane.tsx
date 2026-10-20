/**
 * The text lane: titles along time, one row above the picture tracks.
 *
 * A title is free-floating — it stores its own start — so unlike a media clip
 * it cannot be represented by "the clips before it". It therefore gets its own
 * lane rather than living on a video track, and the lane is where the two
 * operations that make sense for a free-floating thing live: drag to move it in
 * time, and drag an edge to make it longer or shorter.
 *
 * Everything snaps to the same edges the rest of the timeline snaps to — clip
 * starts and ends, other titles, and the timeline start — under the same clip
 * and lane toggles, so a card can be lined up against a cut without zooming in.
 */

import { For, onCleanup, Show } from 'solid-js'
import {
  collectTargets,
  snapMove,
  snapTrimEdge,
  thresholdInSeconds,
  type SnapTarget,
} from '../../../model/snapping.js'
import type { TextClip, TextId } from '../../../model/text.js'
import { TEXT_DURATION_MIN } from '../../../model/text.js'
import type { AppState } from '../../store/state.js'
import type { ContextMenuState } from '../ui/ContextMenu.js'
import { focusTitleText } from '../preview/text-focus.js'

type LaneDrag = {
  id: TextId
  mode: 'move' | 'in' | 'out'
  startX: number
  originStart: number
  originEnd: number
  committed: boolean
  locked: SnapTarget | null
}

const LANE_HEIGHT = 30
const SNAP_PIXELS = 10
const DRAG_THRESHOLD = 3

export function TextLane(props: { state: AppState; trackLeft: () => number; menu: ContextMenuState }) {
  const state = props.state
  const texts = () => state.texts()

  let drag: LaneDrag | null = null

  const timeAt = (clientX: number): number => state.xToTime(clientX - props.trackLeft())

  /** The edges a title may align to under the current snap toggles. */
  function snapTargets(exclude: TextId | null): SnapTarget[] {
    const targets: SnapTarget[] = []
    if (state.clipSnap()) {
      targets.push({ time: 0, kind: 'timeline-start', trackId: null, clipId: null })
      for (const other of texts()) {
        if (other.id === exclude) continue
        targets.push({ time: other.start, kind: 'clip-start', trackId: null, clipId: other.id })
        targets.push({
          time: other.start + other.duration,
          kind: 'clip-end',
          trackId: null,
          clipId: other.id,
        })
      }
    }
    if (state.laneSnap()) {
      targets.push(...collectTargets(state.project, { playhead: state.playhead(), includePlayhead: false }))
    }
    return targets
  }

  function snapThreshold(): number {
    return state.snapping() ? thresholdInSeconds(SNAP_PIXELS, state.zoom()) : 0
  }

  function begin(mode: LaneDrag['mode'], clip: TextClip, event: PointerEvent): void {
    if (state.playing()) state.setPlaying(false)
    drag = {
      id: clip.id,
      mode,
      startX: event.clientX,
      originStart: clip.start,
      originEnd: clip.start + clip.duration,
      committed: false,
      locked: null,
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    event.preventDefault()
  }

  function onMove(event: PointerEvent): void {
    if (!drag) return
    if (!drag.committed) {
      if (Math.abs(event.clientX - drag.startX) < DRAG_THRESHOLD) return
      state.commit()
      drag.committed = true
    }
    const delta = state.xToTime(event.clientX - drag.startX)
    const threshold = snapThreshold()
    const targets = threshold > 0 ? snapTargets(drag.id) : []
    const exclude = { clipId: drag.id }
    if (drag.mode === 'move') {
      const raw = Math.max(0, drag.originStart + delta)
      let start = raw
      if (threshold > 0) {
        const snapped = snapMove(
          raw,
          drag.originEnd - drag.originStart,
          targets,
          threshold,
          exclude,
          drag.locked,
        )
        if (snapped && snapped.start >= 0) {
          start = snapped.start
          drag.locked = snapped.target
        } else {
          drag.locked = null
        }
      } else {
        drag.locked = null
      }
      state.moveText(drag.id, start, { commit: false })
      return
    }
    if (drag.mode === 'out') {
      const raw = Math.max(drag.originStart + TEXT_DURATION_MIN, drag.originEnd + delta)
      let end = raw
      if (threshold > 0) {
        const snapped = snapTrimEdge(raw, targets, threshold, exclude, drag.locked)
        if (snapped) {
          end = Math.max(drag.originStart + TEXT_DURATION_MIN, snapped.time)
          drag.locked = snapped.target
        } else {
          drag.locked = null
        }
      } else {
        drag.locked = null
      }
      state.updateText(drag.id, { duration: end - drag.originStart }, { commit: false })
      return
    }
    const raw = Math.min(
      drag.originEnd - TEXT_DURATION_MIN,
      Math.max(0, drag.originStart + delta),
    )
    let start = raw
    if (threshold > 0) {
      const snapped = snapTrimEdge(raw, targets, threshold, exclude, drag.locked)
      if (snapped) {
        start = Math.min(drag.originEnd - TEXT_DURATION_MIN, Math.max(0, snapped.time))
        drag.locked = snapped.target
      } else {
        drag.locked = null
      }
    } else {
      drag.locked = null
    }
    state.updateText(drag.id, { start, duration: drag.originEnd - start }, { commit: false })
  }

  function onUp(): void {
    drag = null
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
  }

  onCleanup(onUp)

  /** Selecting a title brings the playhead into it, so the picture shows it. */
  function select(clip: TextClip): void {
    state.clearSelection()
    state.setActiveText(clip.id)
    const t = state.playhead()
    if (t < clip.start || t > clip.start + clip.duration) state.seek(clip.start)
  }

  function onEmptyPointerDown(event: PointerEvent): void {
    if (event.button !== 0) return
    event.stopPropagation()
    if (state.playing()) state.setPlaying(false)
    state.clearSelection()
    state.setActiveText(null)
    state.seek(Math.max(0, timeAt(event.clientX)))
  }

  function onEmptyDoubleClick(event: MouseEvent): void {
    event.stopPropagation()
    const at = timeAt(event.clientX)
    const threshold = snapThreshold()
    const snapped =
      threshold > 0 ? snapTrimEdge(at, snapTargets(null), threshold) : null
    const start = Math.max(0, snapped ? snapped.time : at)
    state.clearSelection()
    const id = state.addText({ start })
    state.seek(start)
    focusTitleText()
    void id
  }

  return (
    <div
      class="relative z-10 border-b border-line-soft bg-raised/30"
      style={{ height: `${LANE_HEIGHT}px` }}
      data-text-lane
      aria-label="Text track"
      onPointerDown={onEmptyPointerDown}
      onDblClick={onEmptyDoubleClick}
    >
      <Show when={texts().length === 0}>
        <p class="pointer-events-none absolute inset-y-0 left-3 flex items-center text-micro text-faint">
          Double-click to add a title
        </p>
      </Show>

      <For each={texts()}>
        {(clip) => {
          const selected = () => state.activeTextId() === clip.id
          return (
            <div
              class="group absolute top-1 flex h-[22px] cursor-grab items-center overflow-hidden rounded border px-1.5 text-micro active:cursor-grabbing"
              classList={{
                'border-accent bg-accent/25 text-fg': selected(),
                'border-[#c084fc]/40 bg-[#c084fc]/12 text-muted hover:bg-[#c084fc]/20': !selected(),
              }}
              style={{
                left: `${state.timeToX(clip.start)}px`,
                width: `${Math.max(clip.duration * state.zoom(), 8)}px`,
              }}
              data-text-id={clip.id}
              onPointerDown={(event) => {
                if (event.button !== 0) return
                event.stopPropagation()
                select(clip)
                begin('move', clip, event)
              }}
              onDblClick={(event) => {
                event.stopPropagation()
                select(clip)
                focusTitleText()
              }}
              onContextMenu={(event) => {
                event.preventDefault()
                event.stopPropagation()
                select(clip)
                props.menu.show({ kind: 'text', textId: clip.id, x: event.clientX, y: event.clientY })
              }}
            >
              <div
                class="absolute inset-y-0 left-0 z-10 w-1.5 cursor-ew-resize"
                data-handle="in"
                onPointerDown={(event) => {
                  if (event.button !== 0) return
                  event.stopPropagation()
                  select(clip)
                  begin('in', clip, event)
                }}
              />
              <span class="truncate whitespace-nowrap">{clip.text || 'Title'}</span>
              <div
                class="absolute inset-y-0 right-0 z-10 w-1.5 cursor-ew-resize"
                data-handle="out"
                onPointerDown={(event) => {
                  if (event.button !== 0) return
                  event.stopPropagation()
                  select(clip)
                  begin('out', clip, event)
                }}
              />
            </div>
          )
        }}
      </For>
    </div>
  )
}
