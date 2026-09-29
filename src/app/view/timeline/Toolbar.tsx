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
import type { AppState } from '../../store/state.js'
import type { LayoutState } from '../../store/layout.js'
import { PanelToggle } from '../PanelToggle.js'

export function Toolbar(props: { state: AppState; anyClips: () => boolean; layout: LayoutState }) {
  const state = props.state
  const count = (): number => state.selectionCount()

  return (
    <div class="flex h-9 shrink-0 items-center gap-1.5 border-b border-line-soft px-2">
      <button class="btn" onClick={() => state.splitAt(state.playhead())} disabled={!props.anyClips()}>
        Split
      </button>
      <button
        class="btn"
        onClick={() => state.duplicateSelected()}
        disabled={count() === 0}
        title="Copy the selection. A linked pair is copied as a pair (Ctrl+D)"
      >
        {count() > 1 ? `Duplicate ${count()}` : 'Duplicate'}
      </button>
      <button
        class="btn"
        onClick={() => state.deleteSelected()}
        disabled={count() === 0}
        title="Delete the selection. Only selected clips go — not their pairs"
      >
        {count() > 1 ? `Delete ${count()}` : 'Delete'}
      </button>
      <button
        class="btn"
        disabled={!state.selectionHasLinks()}
        onClick={() => state.breakSelectedLinks()}
        title="Cut these clips and their pairs apart, so they edit independently"
      >
        {state.selectionHasLinks() ? 'Break link' : 'unlinked'}
      </button>

      <Show when={count() > 1}>
        <span class="rounded-full border border-accent/50 bg-accent/15 px-2 py-0.5 text-[10.5px] font-semibold text-accent">
          {count()} clips selected
        </span>
      </Show>

      <span class="mx-1 h-5 w-px bg-line" />

      <button
        class="btn"
        classList={{ '!border-accent/50 !text-accent': state.snapping() }}
        disabled={!props.anyClips()}
        onClick={() => state.setSnapping(!state.snapping())}
        title="Magnetic snapping: align clip edges, the playhead, and the timeline start (G)"
      >
        <MagnetIcon on={state.snapping()} />
        snap
      </button>

      {/* Level is audio-only and hide is video-only. A level slider on a video
          clip is a control that cannot do anything, and a "mute" button on a
          video clip is a promise the model refuses to keep. So each lane gets
          the one control that means something for it — and the same M key
          reaches both. */}
      <Show when={state.selectedClip()}>
        {(clip) => (
          <>
          <Show when={clip().lane === 'audio'}>
            <label class="flex items-center gap-2 text-[10.5px] text-muted">
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
          <Show when={clip().lane === 'video'}>
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

      <span class="timecode pr-1 text-[10.5px] text-muted">
        {state.project.video.length} video · {state.project.audio.length} audio
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

function MagnetIcon(props: { on: boolean }) {
  return (
    <svg viewBox="0 0 16 16" class="size-3.5" fill="none" stroke="currentColor" stroke-width="1.4">
      <path d="M4 3v5a4 4 0 0 0 8 0V3" stroke-linecap="round" />
      <path d="M2.5 3h3M10.5 3h3" stroke-linecap="round" opacity={props.on ? 1 : 0.35} />
      <path d="M4 3h3v5M9 3h3" stroke-linecap="round" opacity={props.on ? 1 : 0.35} />
    </svg>
  )
}
