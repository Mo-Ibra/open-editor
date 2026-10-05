/**
 * One track: a labelled row of clips, and a drop target for files dragged in
 * from the media bin.
 */

import { createMemo, For, Show } from 'solid-js'
import { X } from 'lucide-solid'
import { trackById, type TrackId } from '../../../model/project.js'
import { DND_ASSET, draggedAssetId } from '../media/AssetBin.js'
import type { AppState } from '../../store/state.js'
import { Clip } from './Clip.js'
import { DropCue } from './DropCue.js'

export interface DropPreview {
  trackId: TrackId
  time: number
  duration: number
  assetId: string
  mode: 'overwrite' | 'insert'
  incoming?: boolean
}

export interface LaneProps {
  trackId: TrackId
  type: 'video' | 'audio'
  label: string
  state: AppState
  height: number
  dropAt: () => DropPreview | null
  setDropAt: (value: DropPreview | null) => void
  trackLeft: () => number
  /** Whether the track is empty and not the last one, so it may be removed. */
  canRemove?: boolean
  onRemove?: () => void
}

export function Lane(props: LaneProps) {
  const state = props.state
  const clips = () => trackById(state.project, props.trackId)
  const starts = createMemo(() => state.clipStartsFor(props.trackId))
  const preview = (): DropPreview | null => {
    const at = props.dropAt()
    return at?.trackId === props.trackId ? at : null
  }
  const accepts = (): boolean => {
    const at = preview()
    return at ? state.trackAccepts(at.assetId, props.trackId) : false
  }
  const draggingOver = (): boolean => props.dropAt() !== null

  const timeAtClientX = (clientX: number): number => state.xToTime(clientX - props.trackLeft())
  const draggedId = (event: DragEvent): string | null =>
    event.dataTransfer?.getData(DND_ASSET) || draggedAssetId()

  function previewDrop(event: DragEvent): void {
    if (!event.dataTransfer?.types.includes(DND_ASSET)) return
    event.preventDefault()

    const assetId = draggedId(event)
    if (!assetId || !state.trackAccepts(assetId, props.trackId)) {
      props.setDropAt(null)
      return
    }
    const asset = state.getAsset(assetId)
    const raw = timeAtClientX(event.clientX)
    const mode = event.shiftKey ? 'insert' : 'overwrite'
    event.dataTransfer.dropEffect = mode === 'insert' ? 'copy' : 'move'
    props.setDropAt({
      trackId: props.trackId,
      time: state.dropTimeFor(raw, props.trackId),
      duration: asset?.duration ?? 0,
      assetId,
      mode,
    })
  }

  function onDrop(event: DragEvent): void {
    const assetId = draggedId(event)
    if (!assetId) return
    event.preventDefault()
    event.stopPropagation()
    const mode = event.shiftKey ? 'insert' : 'overwrite'
    const time = state.dropTimeFor(timeAtClientX(event.clientX), props.trackId)
    props.setDropAt(null)
    state.addAssetAt(assetId, props.trackId, time, mode)
  }

  return (
    <div
      class="relative border-b border-line-soft last:border-b-0"
      classList={{
        'ring-1 ring-inset ring-accent/60': props.dropAt()?.trackId === props.trackId,
        'bg-accent/5': draggingOver() && !accepts(),
      }}
      data-track={props.trackId}
      data-track-accepts={accepts() ? 'yes' : undefined}
      style={{ height: `${props.height}px` }}
      onDragOver={previewDrop}
      onDragLeave={(event) => {
        const to = event.relatedTarget as Node | null
        if (to && event.currentTarget.contains(to)) return
        props.setDropAt(null)
      }}
      onDrop={onDrop}
    >
      <span class="absolute right-2 top-1.5 z-10 flex items-center gap-1.5">
        <span
          class="pointer-events-none size-1.5 rounded-full"
          classList={{ 'bg-[#4f7dd6]': props.type === 'video', 'bg-[#3f9e78]': props.type === 'audio' }}
        />
        <span class="panel-label pointer-events-none">{props.label}</span>
        <Show when={props.onRemove}>
          <button
            class="rounded p-0.5 text-muted hover:bg-line hover:text-fg disabled:cursor-not-allowed disabled:opacity-30"
            disabled={!props.canRemove}
            onPointerDown={(event) => {
              // The lane lives inside `#timeline-track`, whose pointerdown
              // captures the pointer for dragging. Without this the capture
              // retargets the click away from the button and removal never fires.
              event.stopPropagation()
            }}
            onClick={(event) => {
              event.stopPropagation()
              props.onRemove?.()
            }}
            aria-label={`Remove ${props.label} track`}
            title={
              props.canRemove
                ? 'Remove this track'
                : 'A track with clips must be cleared before it can be removed'
            }
          >
            <X size={12} />
          </button>
        </Show>
      </span>
      <DropCue preview={preview} trackId={props.trackId} state={state} />
      <For each={clips()}>
        {(clip, index) => (
          <Clip
            clip={clip}
            index={index()}
            start={starts()[index()] ?? 0}
            state={state}
            trackId={props.trackId}
            height={props.height - 12}
          />
        )}
      </For>
    </div>
  )
}
