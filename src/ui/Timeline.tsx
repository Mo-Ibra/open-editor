/**
 * The timeline.
 *
 * Clip x-positions come from the *derived* start (§3 of the plan), never from
 * a stored value, so a clip can never drift out of order. Dragging reorders
 * by moving array elements; trimming edits `in`/`out`. Both are O(1) and
 * neither re-encodes anything.
 */

import { For, Show } from 'solid-js'
import { clipDuration, type Clip } from '../project.js'
import type { AppState } from '../state.js'

const HANDLE = 8

export function Timeline(props: { state: AppState }) {
  const state = props.state
  let track!: HTMLDivElement
  let scroller!: HTMLDivElement

  type Drag =
    | { kind: 'playhead' }
    | { kind: 'move'; index: number; grabOffset: number }
    | { kind: 'trim-in'; index: number }
    | { kind: 'trim-out'; index: number }
  let drag: Drag | null = null

  const contentWidth = () => Math.max(600, state.timeToX(state.duration()) + 200)

  /**
   * Tick spacing that stays readable at any zoom: pick the smallest interval
   * that still leaves at least MIN_GAP pixels between labels. Re-derived
   * whenever zoom or duration changes, so it never needs invalidating.
   */
  const MIN_GAP = 90
  const TICK_INTERVALS = [0.04, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800]

  function ticks(): number[] {
    const total = state.duration()
    if (total <= 0) return []
    const step = TICK_INTERVALS.find((i) => i * state.zoom() >= MIN_GAP) ?? TICK_INTERVALS.at(-1)!
    const out: number[] = []
    for (let t = 0; t <= total + 1e-9; t += step) out.push(Number(t.toFixed(4)))
    return out
  }

  function localX(event: PointerEvent | MouseEvent): number {
    return event.clientX - track.getBoundingClientRect().left
  }

  function indexAt(x: number): number {
    const t = state.xToTime(x)
    const clips = state.project.clips
    let start = 0
    for (let i = 0; i < clips.length; i++) {
      const end = start + clipDuration(clips[i]!)
      if (t < end) return i
      start = end
    }
    return Math.max(0, clips.length - 1)
  }

  function onPointerDown(event: PointerEvent): void {
    const target = event.target as HTMLElement
    track.setPointerCapture(event.pointerId)

    if (target.dataset.handle === 'in' || target.dataset.handle === 'out') {
      const index = Number(target.dataset.index)
      drag = { kind: target.dataset.handle === 'in' ? 'trim-in' : 'trim-out', index }
      return
    }
    if (target.dataset.clipIndex !== undefined) {
      const index = Number(target.dataset.clipIndex)
      const clip = state.project.clips[index]!
      state.setSelected(clip.id)
      drag = { kind: 'move', index, grabOffset: state.xToTime(localX(event)) - clipStart(index) }
      return
    }
    drag = { kind: 'playhead' }
    state.setPlaying(false)
    state.seek(state.xToTime(localX(event)))
  }

  function clipStart(index: number): number {
    let start = 0
    for (let i = 0; i < index; i++) start += clipDuration(state.project.clips[i]!)
    return start
  }

  function onPointerMove(event: PointerEvent): void {
    if (!drag) return
    const x = localX(event)

    switch (drag.kind) {
      case 'playhead':
        state.seek(state.xToTime(x))
        return

      case 'move': {
        // Moving changes array order, which changes every downstream x. Track
        // the pointer against the clip's own start so the clip follows the
        // cursor instead of jumping to where it was grabbed.
        const target = indexAt(x - state.timeToX(drag.grabOffset))
        if (target !== drag.index) state.reorder(drag.index, target)
        drag = { ...drag, index: target }
        return
      }

      case 'trim-in': {
        const clip = state.project.clips[drag.index]!
        const timelineT = state.xToTime(x)
        const sourceT = clip.in + (timelineT - clipStart(drag.index))
        state.trim(drag.index, sourceT, clip.out)
        return
      }

      case 'trim-out': {
        const clip = state.project.clips[drag.index]!
        const timelineT = state.xToTime(x)
        const sourceT = clip.in + (timelineT - clipStart(drag.index))
        state.trim(drag.index, clip.in, sourceT)
        return
      }
    }
  }

  function onPointerUp(): void {
    drag = null
  }

  /** A cut goes at the playhead, on the clip under it. */
  function splitHere(): void {
    if (state.duration() === 0) return
    state.splitAt(state.playhead())
  }

  return (
    <section class="timeline">
      <div class="timeline-bar">
        <button onClick={splitHere} disabled={state.project.clips.length === 0}>Split</button>
        <button onClick={() => state.deleteSelected()} disabled={!state.selected()}>Delete</button>
        <span class="spacer" />

        <Show when={state.selectedClip()}>
          {(clip) => (
            <label class="level" title="Level of the selected clip">
              level
              <input
                type="range"
                min="0"
                max="2"
                step="0.01"
                value={clip().gain ?? 1}
                onInput={(e) => state.setClipGain(clip().id, Number(e.currentTarget.value))}
              />
              <span class="dim">{Math.round((clip().gain ?? 1) * 100)}%</span>
              <button
                classList={{ ghost: !clip().muted }}
                onClick={() => state.toggleMute(clip().id)}
                title={clip().muted ? 'Unmute clip' : 'Mute clip'}
              >
                {clip().muted ? 'muted' : 'live'}
              </button>
            </label>
          )}
        </Show>

        <span class="dim">
          {state.project.clips.length} clip{state.project.clips.length === 1 ? '' : 's'}
        </span>
      </div>

      <div class="scroller" ref={scroller}>
        <div
          class="track"
          ref={track}
          style={{ width: `${contentWidth()}px` }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div class="ruler" style={{ height: `${22}px` }}>
            <For each={ticks()}>
              {(tick) => (
                <span class="tick" style={{ left: `${state.timeToX(tick)}px` }}>
                  {formatTick(tick)}
                </span>
              )}
            </For>
          </div>

          <div class="lane">
            <For each={state.project.clips}>
              {(clip, index) => <ClipView clip={clip} index={index()} state={state} />}
            </For>

            <Show when={state.project.clips.length === 0}>
              <p class="hint pad">Click a file in Media to add it here.</p>
            </Show>
          </div>

          <div class="playhead" style={{ left: `${state.timeToX(state.playhead())}px` }} />
        </div>
      </div>
    </section>
  )
}

function ClipView(props: { clip: Clip; index: number; state: AppState }) {
  const state = props.state
  const rect = () => state.clipRect(props.index)
  const asset = () => state.getAsset(props.clip.assetId)
  const isSelected = () => state.selected() === props.clip.id

  return (
    <div
      class="clip"
      classList={{ selected: isSelected() }}
      data-clip-index={props.index}
      style={{
        left: `${rect().left}px`,
        width: `${Math.max(2, rect().width)}px`,
        '--tint': tint(props.index),
      }}
      title={`${asset()?.name ?? 'missing'} — ${formatTime(props.clip.in)} → ${formatTime(props.clip.out)}`}
    >
      <div
        class="handle in"
        data-handle="in"
        data-index={props.index}
        style={{ width: `${HANDLE}px` }}
      />
      <span class="clip-name">{asset()?.name ?? '?'}</span>
      <div
        class="handle out"
        data-handle="out"
        data-index={props.index}
        style={{ width: `${HANDLE}px` }}
      />
    </div>
  )
}

const TINTS = [
  'hsl(215 65% 52%)',
  'hsl(160 60% 42%)',
  'hsl(28 75% 52%)',
  'hsl(275 60% 58%)',
  'hsl(340 65% 55%)',
  'hsl(48 70% 48%)',
]
function tint(index: number): string {
  return TINTS[index % TINTS.length]!
}

function formatTick(t: number): string {
  if (t < 1) return `${t.toFixed(t < 0.25 ? 2 : 1)}s`
  const m = Math.floor(t / 60)
  const s = Math.round(t % 60)
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`
}

function formatTime(t: number): string {
  return `${t.toFixed(2)}s`
}
