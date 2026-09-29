/**
 * The time ruler.
 *
 * Markup only — the spacing and label logic is in `ticks.ts`, so it can be
 * tested without a browser.
 */

import { For } from 'solid-js'
import type { AppState } from '../../store/state.js'
import { formatTick, ticks } from './ticks.js'

export function Ruler(props: {
  state: AppState
  onDragOver: (event: DragEvent) => void
  onDrop: (event: DragEvent) => void
}) {
  const state = props.state
  return (
    <div
      class="sticky top-0 h-6 border-b border-line bg-raised/80 backdrop-blur"
      onDragOver={props.onDragOver}
      onDrop={props.onDrop}
    >
      <For each={ticks(state.duration(), state.zoom())}>
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
  )
}
