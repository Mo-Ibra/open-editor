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
import type { AppState } from '../../store/state.js'

export function Transport(props: { state: AppState; ticks: () => number }) {
  const state = props.state
  return (
    <div class="flex h-12 shrink-0 items-center gap-3 border-t border-line bg-panel px-3">
      <div class="flex items-center gap-1">
        <button class="btn !px-2" onClick={() => state.step(-1)} title="Previous frame (←)">
          <SkipIcon dir="left" />
        </button>
        <button
          class="grid size-7 place-items-center rounded-full bg-fg text-bg transition-transform hover:scale-105 active:scale-95"
          onClick={() => void state.togglePlay()}
          title={state.playing() ? 'Pause (space)' : 'Play (space)'}
        >
          {state.playing() ? <PauseIcon /> : <PlayIcon />}
        </button>
        <button class="btn !px-2" onClick={() => state.step(1)} title="Next frame (→)">
          <SkipIcon dir="right" />
        </button>
        <button
          classList={{ 'btn !px-2': true, 'text-warn!': state.audio.isMuted }}
          onClick={() => state.audio.setMuted(!state.audio.isMuted)}
          title={state.audio.isMuted ? 'Unmute (M)' : 'Mute (M)'}
        >
          <SpeakerIcon muted={state.audio.isMuted} />
        </button>
      </div>

      <div class="timecode flex items-baseline gap-1.5 text-[12px]">
        <span>{formatTime(state.playhead())}</span>
        <span class="text-muted">/</span>
        <span class="text-muted">{formatTime(state.duration())}</span>
      </div>

      <span class="flex-1" />

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
  )
}

function formatTime(seconds: number): string {
  const s = Math.max(0, seconds)
  const m = Math.floor(s / 60)
  const rest = s - m * 60
  return `${m}:${rest.toFixed(2).padStart(5, '0')}`
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" class="size-3" fill="currentColor">
      <path d="M4 2.5v11l9-5.5-9-5.5Z" />
    </svg>
  )
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 16 16" class="size-3" fill="currentColor">
      <rect x="3.5" y="2.5" width="3.5" height="11" rx="1" />
      <rect x="9" y="2.5" width="3.5" height="11" rx="1" />
    </svg>
  )
}

function SkipIcon(props: { dir: 'left' | 'right' }) {
  return (
    <svg
      viewBox="0 0 16 16"
      class="size-3.5"
      fill="currentColor"
      style={{ transform: props.dir === 'left' ? 'scaleX(-1)' : undefined }}
    >
      <path d="M3 3h1.6v10H3V3Zm9 0v10l-6-5 6-5Z" />
    </svg>
  )
}

function SpeakerIcon(props: { muted: boolean }) {
  return (
    <svg viewBox="0 0 16 16" class="size-3.5" fill="currentColor">
      <path d="M7 2.5 4.2 5H2v6h2.2L7 13.5v-11Z" />
      {props.muted ? (
        <path
          d="M10 6l3 4M13 6l-3 4"
          stroke="currentColor"
          stroke-width="1.3"
          fill="none"
          stroke-linecap="round"
        />
      ) : (
        <path
          d="M9.5 5.5a3.4 3.4 0 0 1 0 5M11.5 3.5a6 6 0 0 1 0 9"
          stroke="currentColor"
          stroke-width="1.3"
          fill="none"
          stroke-linecap="round"
        />
      )}
    </svg>
  )
}
