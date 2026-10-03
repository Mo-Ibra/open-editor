/**
 * The transport bar under the preview: play/pause, frame stepping, mute, the
 * time readout, and the zoom slider.
 *
 * The "playing N" readout carries the tick count on purpose. It is the only
 * thing that proves the clock is actually running, which is otherwise
 * indistinguishable from a play button that does nothing.
 *
 * Markup only, and it reads nothing but the store — which is what makes it
 * safely extractable. The render loop beside it reaches into eight component
 * locals and is not.
 */

import { Show } from 'solid-js'
import type { Accessor } from 'solid-js'
import { Eye, EyeOff, Maximize2, Minimize2, Pause, Play, SkipBack, SkipForward, Volume2, VolumeX } from 'lucide-solid'
import type { AppState } from '../../store/state.js'
import { formatTime } from '../format.js'
import { Tooltip } from '../ui/Tooltip.js'
import { Scrubber } from './Scrubber.js'

export function Transport(props: {
  state: AppState
  ticks: () => number
  pictureHidden: Accessor<boolean>
  fullscreen: Accessor<boolean>
  onToggleFullscreen: () => void
  onTogglePicture: () => void
}) {
  const state = props.state
  return (
    <div class="flex h-[48px] shrink-0 flex-col border-t border-line bg-panel">
      <Scrubber state={state} />
      <div class="flex min-h-0 flex-1 items-center gap-3 px-3">
      <div class="flex items-center gap-1">
        <Tooltip label="Previous frame (←)">
          <button class="btn !px-2" onClick={() => state.step(-1)} aria-label="Previous frame">
            <SkipBack size={15} />
          </button>
        </Tooltip>
        <Tooltip label={state.playing() ? 'Pause (space)' : 'Play (space)'}>
          <button
            class="grid size-7 place-items-center rounded-full bg-fg text-bg transition-transform hover:scale-105 active:scale-95"
            onClick={() => void state.togglePlay()}
            aria-label={state.playing() ? 'Pause' : 'Play'}
          >
            {state.playing() ? <Pause size={14} /> : <Play size={14} />}
          </button>
        </Tooltip>
        <Tooltip label="Next frame (→)">
          <button class="btn !px-2" onClick={() => state.step(1)} aria-label="Next frame">
            <SkipForward size={15} />
          </button>
        </Tooltip>
        {/* Only when the project actually has sound. A master mute on an empty
            timeline is a control that cannot do anything. */}
        <Show when={state.project.audio.length > 0}>
          <Tooltip label={state.audio.isMuted ? 'Unmute (M)' : 'Mute (M)'}>
            <button
              classList={{ 'btn !px-2': true, 'text-warn!': state.audio.isMuted }}
              onClick={() => state.audio.setMuted(!state.audio.isMuted)}
              aria-label={state.audio.isMuted ? 'Unmute' : 'Mute'}
            >
              {state.audio.isMuted ? <VolumeX size={15} /> : <Volume2 size={15} />}
            </button>
          </Tooltip>
        </Show>
      </div>

      <div class="timecode flex items-baseline gap-1.5 text-[12px]">
        <span>{formatTime(state.playhead())}</span>
        <span class="text-muted">/</span>
        <span class="text-muted">{formatTime(state.duration())}</span>
      </div>

      <span class="flex-1" />

      <Tooltip label={props.pictureHidden() ? 'Show the picture (H)' : 'Hide the picture (H)'}>
        <button
          class="btn !px-2"
          onClick={props.onTogglePicture}
          aria-pressed={props.pictureHidden()}
          aria-label={props.pictureHidden() ? 'Show the picture' : 'Hide the picture'}
          data-preview-action="picture"
        >
          {props.pictureHidden() ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      </Tooltip>
      <Tooltip label={props.fullscreen() ? 'Leave full screen (F)' : 'Full screen (F)'}>
        <button
          class="btn !px-2"
          onClick={props.onToggleFullscreen}
          aria-pressed={props.fullscreen()}
          aria-label={props.fullscreen() ? 'Leave full screen' : 'Full screen'}
          data-preview-action="fullscreen"
        >
          {props.fullscreen() ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
      </Tooltip>

      <label class="flex items-center gap-2 text-[10.5px] text-muted">
        <span>zoom</span>
        {/* The picture's zoom, not the timeline's. The exact timeline zoom is
            read from the track's data-zoom, because this slider is step="10"
            and cannot report a precise value. */}
        <input
          type="range"
          min="10"
          max="400"
          step="10"
          class="w-28"
          value={state.zoom()}
          onInput={(e) => state.setZoom(Number(e.currentTarget.value))}
        />
      </label>

      <span
        class="timecode rounded border border-line bg-raised px-1.5 py-0.5 text-[10px] text-muted"
        title="playback state — the tick count proves the clock is running"
      >
        <Show when={state.playing()} fallback={<>stopped</>}>
          playing {props.ticks()}
        </Show>{' '}
        · ph {state.playhead().toFixed(2)}
      </span>
      </div>
    </div>
  )
}
