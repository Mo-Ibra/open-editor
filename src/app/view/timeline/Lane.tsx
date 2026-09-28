/**
 * One lane: a labelled row of clips, and a drop target for files dragged in
 * from the media bin.
 *
 * The two lanes are the whole reason the model has two. Trimming the picture
 * while keeping the sound, or cutting a voiceover with no picture, are ordinary
 * things to want and neither is expressible with a single fused clip. Linked
 * pairs edit together by default; breaking the link is one click.
 */

import { For } from 'solid-js'
import { laneOf, type Lane } from '../../../model/project.js'
import { DND_ASSET } from '../AssetBin.js'
import type { AppState } from '../../store/state.js'
import { Clip } from './Clip.js'

export interface LaneProps {
  lane: Lane
  label: string
  state: AppState
  height: number
  /** Where a dragged file would land, or null when not dragging. */
  dropAt: () => { lane: Lane; time: number } | null
  setDropAt: (value: { lane: Lane; time: number } | null) => void
  /** Origin of the scrolled track, for converting a drop's clientX. */
  trackLeft: () => number
}

export function Lane(props: LaneProps) {
  const state = props.state
  const clips = () => laneOf(state.project, props.lane)

  function timeAtClientX(clientX: number): number {
    return state.xToTime(clientX - props.trackLeft())
  }

  function onDragOver(event: DragEvent): void {
    // Without preventDefault the browser refuses the drop outright.
    if (!event.dataTransfer?.types.includes(DND_ASSET)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    props.setDropAt({ lane: props.lane, time: timeAtClientX(event.clientX) })
  }

  function onDrop(event: DragEvent): void {
    const assetId = event.dataTransfer?.getData(DND_ASSET)
    if (!assetId) return
    event.preventDefault()
    // Placed where it was let go, so a drop into empty timeline leaves a gap.
    state.addAssetAt(assetId, props.lane, timeAtClientX(event.clientX))
    props.setDropAt(null)
  }

  return (
    <div
      class="relative border-b border-line-soft last:border-b-0"
      classList={{ 'ring-1 ring-inset ring-accent/60': props.dropAt()?.lane === props.lane }}
      data-lane={props.lane}
      style={{ height: `${props.height}px` }}
      onDragOver={onDragOver}
      onDragLeave={() => props.setDropAt(null)}
      onDrop={onDrop}
    >
      <span class="panel-label pointer-events-none absolute right-2 top-1.5 z-10">{props.label}</span>
      <For each={clips()}>
        {(clip, index) => (
          <Clip clip={clip} index={index()} state={state} lane={props.lane} height={props.height - 12} />
        )}
      </For>
    </div>
  )
}
