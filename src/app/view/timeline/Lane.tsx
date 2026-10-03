/**
 * One lane: a labelled row of clips, and a drop target for files dragged in
 * from the media bin.
 *
 * The two lanes are the whole reason the model has two. Trimming the picture
 * while keeping the sound, or cutting a voiceover with no picture, are ordinary
 * things to want and neither is expressible with a single fused clip. Linked
 * pairs edit together by default; breaking the link is one click.
 */

import { createMemo, For } from 'solid-js'
import { laneOf, type Lane } from '../../../model/project.js'
import { DND_ASSET, draggedAssetId } from '../AssetBin.js'
import type { AppState } from '../../store/state.js'
import { Clip } from './Clip.js'
import { DropCue } from './DropCue.js'

export interface DropPreview {
  lane: Lane
  /** Where it lands, already snapped. */
  time: number
  /** How wide the incoming clip would be, so the indicator can show extent. */
  duration: number
  /** Empty when the drag carries a file we have not imported yet. */
  assetId: string
  mode: 'overwrite' | 'insert'
  /** A file from the desktop: real extent is unknown until it is decoded. */
  incoming?: boolean
}

export interface LaneProps {
  lane: Lane
  label: string
  state: AppState
  height: number
  /** Where a dragged file would land, or null when not dragging. */
  dropAt: () => DropPreview | null
  setDropAt: (value: DropPreview | null) => void
  /** Origin of the scrolled track, for converting a drop's clientX. */
  trackLeft: () => number
}

export function Lane(props: LaneProps) {
  const state = props.state
  const clips = () => laneOf(state.project, props.lane)
  /**
   * Every clip's timeline start, once per lane change.
   *
   * The alternative was each `Clip` asking for its own position, and every one of
   * those summing the lane from zero — quadratic on every repaint, and a repaint
   * happens on every `pointermove` of a drag. This memo recomputes only when the
   * lane actually changes.
   */
  const starts = createMemo(() => state.clipStartsFor(props.lane))
  const preview = (): DropPreview | null => {
    const at = props.dropAt()
    return at?.lane === props.lane ? at : null
  }
  const accepts = (): boolean => {
    const at = preview()
    return at ? state.laneAccepts(at.assetId, props.lane) : false
  }
  const draggingOver = (): boolean => props.dropAt() !== null

  const timeAtClientX = (clientX: number): number => state.xToTime(clientX - props.trackLeft())
  // `getData` is empty during `dragover` in browsers that enforce protected
  // mode, so the id recorded at `dragstart` is the reliable source here.
  const draggedId = (event: DragEvent): string | null =>
    event.dataTransfer?.getData(DND_ASSET) || draggedAssetId()

  /**
   * Work out what a drag over this lane would do, and show it.
   *
   * The preview is the point. A drop target that only tints on hover leaves the
   * user guessing where the clip will land and what it will destroy; showing
   * the extent and the mode answers both before the mouse button is released.
   */
  function previewDrop(event: DragEvent): void {
    if (!event.dataTransfer?.types.includes(DND_ASSET)) return
    // Without preventDefault the browser refuses the drop outright.
    event.preventDefault()

    const assetId = draggedId(event)
    if (!assetId || !state.laneAccepts(assetId, props.lane)) {
      props.setDropAt(null)
      return
    }
    const asset = state.getAsset(assetId)
    const raw = timeAtClientX(event.clientX)
    // Shift means "insert and push the rest along", which is the one thing the
    // user cannot undo by letting go somewhere else.
    const mode = event.shiftKey ? 'insert' : 'overwrite'
    event.dataTransfer.dropEffect = mode === 'insert' ? 'copy' : 'move'
    props.setDropAt({
      lane: props.lane,
      time: state.dropTimeFor(raw, props.lane),
      duration: asset?.duration ?? 0,
      assetId,
      mode,
    })
  }

  function onDrop(event: DragEvent): void {
    const assetId = draggedId(event)
    // A file from the desktop has no asset id yet; leave it for the track (and
    // the shell) rather than swallowing it here.
    if (!assetId) return
    event.preventDefault()
    // The track handler would otherwise see the same drop and add the clip a
    // second time.
    event.stopPropagation()
    const mode = event.shiftKey ? 'insert' : 'overwrite'
    // Snapped here as well as in the preview, so what was drawn is what happens
    // even if the pointer moved a pixel between the last dragover and the drop.
    const time = state.dropTimeFor(timeAtClientX(event.clientX), props.lane)
    props.setDropAt(null)
    state.addAssetAt(assetId, props.lane, time, mode)
  }

  return (
    <div
      class="relative border-b border-line-soft last:border-b-0"
      classList={{
        // Only the lane that would actually take the file lights up. Tinting
        // both and letting one refuse is a worse answer than saying no.
        'ring-1 ring-inset ring-accent/60': props.dropAt()?.lane === props.lane,
        'bg-accent/5': draggingOver() && !accepts(),
      }}
      data-lane={props.lane}
      data-lane-accepts={accepts() ? 'yes' : undefined}
      style={{ height: `${props.height}px` }}
      onDragOver={previewDrop}
      onDragLeave={(event) => {
        // `dragleave` also fires when the pointer moves from the lane onto one
        // of its own children (a clip, a handle). Clearing on those made the cue
        // flicker. Only a leave to somewhere outside the lane is real.
        const to = event.relatedTarget as Node | null
        if (to && event.currentTarget.contains(to)) return
        props.setDropAt(null)
      }}
      onDrop={onDrop}
    >
      <span class="pointer-events-none absolute right-2 top-1.5 z-10 flex items-center gap-1.5">
        <span
          class="size-1.5 rounded-full"
          classList={{ 'bg-[#4f7dd6]': props.lane === 'video', 'bg-[#3f9e78]': props.lane === 'audio' }}
        />
        <span class="panel-label">{props.label}</span>
      </span>
      <DropCue preview={preview} lane={props.lane} state={state} />
      <For each={clips()}>
        {(clip, index) => (
          <Clip
            clip={clip}
            index={index()}
            start={starts()[index()] ?? 0}
            state={state}
            lane={props.lane}
            height={props.height - 12}
          />
        )}
      </For>
    </div>
  )
}
