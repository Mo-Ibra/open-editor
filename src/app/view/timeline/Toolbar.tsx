/**
 * The timeline toolbar.
 *
 * Every button names its own count when more than one clip is selected, rather
 * than leaving the user to count rings. A multi-selection is genuinely easy to
 * miss when the clips are small or in different lanes, and "did that action
 * apply to two clips or one?" is the question immediately after every one of
 * these buttons.
 */

import { Show } from 'solid-js'
import { Copy, Crosshair, Magnet, Plus, Rows3, Scissors, Trash2, Unlink } from 'lucide-solid'
import { trackTypeById } from '../../../model/project.js'
import type { AppState } from '../../store/state.js'
import type { LayoutState } from '../../store/layout.js'
import { PanelToggle } from '../shell/PanelToggle.js'

export function Toolbar(props: { state: AppState; anyClips: () => boolean; layout: LayoutState }) {
  const state = props.state
  const count = (): number => state.selectionCount()
  const clipIsAudio = (): boolean => {
    const clip = state.selectedClip()
    return clip ? trackTypeById(state.project, clip.trackId) === 'audio' : false
  }
  const clipIsVideo = (): boolean => {
    const clip = state.selectedClip()
    return clip ? trackTypeById(state.project, clip.trackId) === 'video' : false
  }
  const videoClipCount = (): number =>
    state.project.tracks.filter((t) => t.type === 'video').reduce((n, t) => n + t.clips.length, 0)
  const audioClipCount = (): number =>
    state.project.tracks.filter((t) => t.type === 'audio').reduce((n, t) => n + t.clips.length, 0)

  return (
    <div class="flex h-9 shrink-0 items-center gap-1.5 border-b border-line-soft px-2">
      <button class="btn" onClick={() => state.splitAt(state.playhead())} disabled={!props.anyClips()}>
        <Scissors size={13} /> Split
      </button>
      <button
        class="btn"
        onClick={() => state.duplicateSelected()}
        disabled={count() === 0}
        title="Copy the selection. A linked pair is copied as a pair (Ctrl+D)"
      >
        <Copy size={13} /> {count() > 1 ? `Duplicate ${count()}` : 'Duplicate'}
      </button>
      <button
        class="btn"
        onClick={() => state.deleteSelected()}
        disabled={count() === 0}
        title="Delete the selection. Only selected clips go — not their pairs"
      >
        <Trash2 size={13} /> {count() > 1 ? `Delete ${count()}` : 'Delete'}
      </button>
      <button
        class="btn"
        disabled={!state.selectionHasLinks()}
        onClick={() => state.breakSelectedLinks()}
        title="Cut these clips and their pairs apart, so they edit independently"
      >
        <Unlink size={13} /> {state.selectionHasLinks() ? 'Break link' : 'unlinked'}
      </button>

      <Show when={count() > 1}>
        <span class="rounded-full border border-accent/50 bg-accent/15 px-2 py-0.5 text-tiny font-semibold text-accent">
          {count()} clips selected
        </span>
      </Show>

      <span class="mx-1 h-5 w-px bg-line" />

      <button
        class="btn"
        classList={{ '!border-accent/50 !text-accent': state.clipSnap() }}
        disabled={!props.anyClips()}
        onClick={() => state.setClipSnap(!state.clipSnap())}
        title="Clip snap: a dragged clip or trim pulls to other clips in the same lane, and the timeline start (G)"
      >
        <Magnet size={14} />
        clip
      </button>
      <button
        class="btn"
        classList={{ '!border-accent/50 !text-accent': state.laneSnap() }}
        disabled={!props.anyClips()}
        onClick={() => state.setLaneSnap(!state.laneSnap())}
        title="Lane snap: also pull to clips in the other lane, so picture lines up with sound (⇧G)"
      >
        <Rows3 size={14} />
        lane
      </button>
      <button
        class="btn"
        classList={{ '!border-accent/50 !text-accent': state.playheadSnap() }}
        disabled={!props.anyClips()}
        onClick={() => state.setPlayheadSnap(!state.playheadSnap())}
        title="Playhead snap: dragging the playhead pulls it to a nearby clip edge (P)"
      >
        <Crosshair size={14} />
        playhead
      </button>

      <span class="mx-1 h-5 w-px bg-line" />

      {/* More tracks, on demand: another layer of picture for a montage, or
          another stream of sound. The model has always held N tracks — these
          are the two ways to make one. */}
      <button
        class="btn"
        onClick={() => state.addTrack('video')}
        title="Add a video track above the existing ones, for another layer of picture"
      >
        <Plus size={13} /> video
      </button>
      <button
        class="btn"
        onClick={() => state.addTrack('audio')}
        title="Add an audio track below the existing ones, for another stream of sound"
      >
        <Plus size={13} /> audio
      </button>

      {/* Level is audio-only and hide is video-only. A level slider on a video
          clip is a control that cannot do anything, and a "mute" button on a
          video clip is a promise the model refuses to keep. So each lane gets
          the one control that means something for it — and the same M key
          reaches both. */}
      <Show when={state.selectedClip()}>
        {(clip) => (
          <>
          <Show when={clipIsAudio()}>
            <label class="flex items-center gap-2 text-tiny text-muted">
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
              <button
                class="btn !py-0.5"
                classList={{ '!border-accent/50 !text-accent': clip().muted }}
                onClick={() => state.toggleHidden(clip().id)}
                aria-pressed={Boolean(clip().muted)}
                title={clip().muted ? 'Unmute this clip (M)' : 'Mute this clip (M)'}
              >
                {clip().muted ? 'muted' : 'live'}
              </button>
            </label>
          </Show>
          <Show when={clipIsVideo()}>
            <button
              class="btn !py-0.5"
              classList={{ '!border-accent/50 !text-accent': clip().hidden }}
              onClick={() => state.toggleHidden(clip().id)}
              aria-pressed={Boolean(clip().hidden)}
              title={
                clip().hidden
                  ? 'Show this clip again — the picture is black while it is hidden (M)'
                  : 'Hide this clip — black in the preview and in the export, audio untouched (M)'
              }
            >
              {clip().hidden ? 'hidden' : 'visible'}
            </button>
          </Show>
          </>
        )}
      </Show>

      <span class="flex-1" />

      <span class="timecode pr-1 text-tiny text-muted">
        {videoClipCount()} video · {audioClipCount()} audio
      </span>
      <PanelToggle
        panel="timeline"
        collapsed={props.layout.timelineCollapsed()}
        onToggle={() => props.layout.toggleTimeline()}
        disabledReason={
          props.layout.canCollapseTimeline()
            ? undefined
            : 'The picture is hidden, so the timeline has the whole column'
        }
        dir="down"
      />
    </div>
  )
}
