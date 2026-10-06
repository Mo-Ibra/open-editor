/**
 * The text lane: titles along time, one row above the picture tracks.
 *
 * A title is free-floating — it stores its own start — so unlike a media clip
 * it cannot be represented by "the clips before it". It therefore gets its own
 * lane rather than living on a video track, and the lane is where the two
 * operations that make sense for a free-floating thing live: drag to move it in
 * time, and drag an edge to make it longer or shorter.
 *
 * Everything snaps to the same edges the rest of the timeline snaps to — the
 * playhead, clip starts and ends, and other titles — so a card can be lined up
 * against a cut without zooming in.
 */

import { For, Show } from 'solid-js'
import { clipDuration } from '../../../model/project.js'
import type { TextClip, TextId } from '../../../model/text.js'
import { TEXT_DURATION_MIN } from '../../../model/text.js'
import type { AppState } from '../../store/state.js'
import type { ContextMenuState } from '../ui/ContextMenu.js'

type LaneDrag = {
  id: TextId
  mode: 'move' | 'in' | 'out'
  startX: number
  originStart: number
  originEnd: number
  committed: boolean
}

const LANE_HEIGHT = 30
const SNAP_PX = 8

export function TextLane(props: { state: AppState; trackLeft: () => number; menu: ContextMenuState }) {
  const state = props.state
  const texts = () => state.texts()

  let drag: LaneDrag | null = null

  const timeAt = (clientX: number): number => state.xToTime(clientX - props.trackLeft())

  /** Nearest edge to `t` within a few pixels, or `t` itself. */
  function snap(t: number, exclude: TextId | null): number {
    const threshold = SNAP_PX / state.zoom()
    let best = t
    let bestDistance = threshold
    const consider = (candidate: number): void => {
      const distance = Math.abs(candidate - t)
      if (distance < bestDistance) {
        bestDistance = distance
        best = candidate
      }
    }

    consider(state.playhead())
    for (const track of state.project.tracks) {
      const starts = state.clipStartsFor(track.id)
      for (let i = 0; i < track.clips.length; i++) {
        const start = starts[i] ?? 0
        consider(start)
        consider(start + clipDuration(track.clips[i]!))
      }
    }
    for (const other of texts()) {
      if (other.id === exclude) continue
      consider(other.start)
      consider(other.start + other.duration)
    }
    return best
  }

  function begin(mode: LaneDrag['mode'], clip: TextClip, event: PointerEvent): void {
    drag = {
      id: clip.id,
      mode,
      startX: event.clientX,
      originStart: clip.start,
      originEnd: clip.start + clip.duration,
      committed: false,
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    event.preventDefault()
  }

  function onMove(event: PointerEvent): void {
    if (!drag) return
    if (!drag.committed) {
      state.commit()
      drag.committed = true
    }
    const delta = state.xToTime(event.clientX - drag.startX)
    if (drag.mode === 'move') {
      const start = Math.max(0, snap(drag.originStart + delta, drag.id))
      state.moveText(drag.id, start, { commit: false })
      return
    }
    if (drag.mode === 'out') {
      const end = Math.max(drag.originStart + TEXT_DURATION_MIN, snap(drag.originEnd + delta, drag.id))
      state.updateText(drag.id, { duration: end - drag.originStart }, { commit: false })
      return
    }
    const start = Math.min(
      drag.originEnd - TEXT_DURATION_MIN,
      Math.max(0, snap(drag.originStart + delta, drag.id)),
    )
    state.updateText(drag.id, { start, duration: drag.originEnd - start }, { commit: false })
  }

  function onUp(): void {
    drag = null
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
  }

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
    state.clearSelection()
    state.setActiveText(null)
    state.seek(Math.max(0, timeAt(event.clientX)))
  }

  function onEmptyDoubleClick(event: MouseEvent): void {
    event.stopPropagation()
    const start = Math.max(0, snap(timeAt(event.clientX), null))
    state.clearSelection()
    const id = state.addText({ start })
    state.seek(start)
    void id
  }

  return (
    <div
      class="relative z-10 border-b border-line-soft bg-raised/30"
      style={{ height: `${LANE_HEIGHT}px` }}
      data-text-lane
      onPointerDown={onEmptyPointerDown}
      onDblClick={onEmptyDoubleClick}
    >
      <span class="pointer-events-none absolute right-2 top-1.5 z-10 flex items-center gap-1.5">
        <span class="size-1.5 rounded-full bg-[#c084fc]" />
        <span class="panel-label">text</span>
      </span>

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
              onDblClick={(event) => event.stopPropagation()}
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
