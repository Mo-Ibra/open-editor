/**
 * The timeline: two lanes, with a waveform on the audio one.
 *
 * Clip x-positions come from the *derived* start, never a stored value, so a
 * clip cannot drift out of order however it was edited (§3).
 *
 * The lanes are the whole reason the model has two. Trimming the picture
 * while keeping the sound, or cutting a voiceover with no picture, are ordinary
 * things to want and neither is expressible with a single fused clip. Linked
 * pairs edit together by default; breaking the link is one click.
 */

import { createEffect, For, onMount, Show } from 'solid-js'
import { clipDuration, clipStart, laneOf, type Clip, type Lane } from '../project.js'
import { drawPeaks, type Peak } from '../peaks.js'
import type { AppState } from '../state.js'
import { log } from '../debug.js'

const HANDLE = 8
const VIDEO_LANE_HEIGHT = 46
const AUDIO_LANE_HEIGHT = 52

type Drag =
  | { kind: 'playhead' }
  | { kind: 'move'; lane: Lane; index: number; grabOffset: number }
  | { kind: 'trim-in'; lane: Lane; index: number }
  | { kind: 'trim-out'; lane: Lane; index: number }

export function Timeline(props: { state: AppState }) {
  const state = props.state
  let track!: HTMLDivElement

  let drag: Drag | null = null

  const contentWidth = () => Math.max(600, state.timeToX(state.duration()) + 200)

  function localX(event: PointerEvent | MouseEvent): number {
    return event.clientX - track.getBoundingClientRect().left
  }

  function laneStart(lane: Lane, index: number): number {
    return clipStart(laneOf(state.project, lane), index)
  }

  /** Which index in this lane is under x? */
  function indexAt(lane: Lane, x: number): number {
    const t = state.xToTime(x)
    const clips = laneOf(state.project, lane)
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

    const lane = (target.closest('[data-lane]')?.getAttribute('data-lane') as Lane | undefined) ?? null

    if (target.dataset.handle === 'in' || target.dataset.handle === 'out') {
      if (!lane) return
      const index = Number(target.dataset.index)
      drag = { kind: target.dataset.handle === 'in' ? 'trim-in' : 'trim-out', lane, index }
      return
    }
    if (target.dataset.clipIndex !== undefined && lane) {
      const index = Number(target.dataset.clipIndex)
      const clip = laneOf(state.project, lane)[index]!
      state.setSelected(clip.id)
      drag = { kind: 'move', lane, index, grabOffset: state.xToTime(localX(event)) - laneStart(lane, index) }
      return
    }

    drag = { kind: 'playhead' }
    state.setPlaying(false)
    state.seek(state.xToTime(localX(event)))
  }

  function onPointerMove(event: PointerEvent): void {
    if (!drag) return
    const x = localX(event)

    switch (drag.kind) {
      case 'playhead':
        state.seek(state.xToTime(x))
        return

      case 'move': {
        const target = indexAt(drag.lane, x - state.timeToX(drag.grabOffset))
        if (target !== drag.index) {
          state.reorder(drag.lane, drag.index, target)
          drag = { ...drag, index: target }
        }
        return
      }

      case 'trim-in': {
        const clips = laneOf(state.project, drag.lane)
        const clip = clips[drag.index]
        if (!clip) return
        const timelineT = state.xToTime(x)
        const sourceT = clip.in + (timelineT - laneStart(drag.lane, drag.index))
        state.trim(drag.lane, drag.index, sourceT, clip.out)
        return
      }

      case 'trim-out': {
        const clips = laneOf(state.project, drag.lane)
        const clip = clips[drag.index]
        if (!clip) return
        const timelineT = state.xToTime(x)
        const sourceT = clip.in + (timelineT - laneStart(drag.lane, drag.index))
        state.trim(drag.lane, drag.index, clip.in, sourceT)
        return
      }
    }
  }

  function onPointerUp(): void {
    drag = null
  }

  /** Tick spacing that stays readable at any zoom. */
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

  // Kick off peak computation for every audio-bearing clip, so the waveform is
  // there by the time anyone looks at it.
  createEffect(() => {
    for (const clip of state.project.audio) {
      void state.peaksFor(clip.assetId)
    }
  })

  return (
    <section class="timeline">
      <div class="timeline-bar">
        <button onClick={() => state.splitAt(state.playhead())} disabled={!state.project.video.length && !state.project.audio.length}>
          Split
        </button>
        <button onClick={() => state.deleteSelected()} disabled={!state.selected()}>Delete</button>

        <button
          classList={{ ghost: !state.selectedIsLinked() }}
          disabled={!state.selectedIsLinked()}
          onClick={() => state.breakSelectedLink()}
          title="Cut this clip and its pair apart, so they edit independently"
        >
          {state.selectedIsLinked() ? 'Break link' : 'unlinked'}
        </button>

        <span class="spacer" />

        <Show when={state.selectedClip()}>
          {(clip) => (
            <label class="level" title="Level of the selected audio clip">
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
              <Show when={clip().lane === 'audio'}>
                <button classList={{ ghost: !clip().muted }} onClick={() => state.toggleMute(clip().id)}>
                  {clip().muted ? 'muted' : 'live'}
                </button>
              </Show>
            </label>
          )}
        </Show>

        <span class="dim">
          {state.project.video.length} video · {state.project.audio.length} audio
        </span>
      </div>

      <div class="scroller">
        <div
          class="track"
          ref={track}
          style={{ width: `${contentWidth()}px` }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div class="ruler">
            <For each={ticks()}>
              {(tick) => (
                <span class="tick" style={{ left: `${state.timeToX(tick)}px` }}>
                  {formatTick(tick)}
                </span>
              )}
            </For>
          </div>

          <LaneView lane="video" label="video" state={state} height={VIDEO_LANE_HEIGHT} />
          <LaneView lane="audio" label="audio" state={state} height={AUDIO_LANE_HEIGHT} />

          <Show when={!state.project.video.length && !state.project.audio.length}>
            <p class="hint pad">Click a file in Media to add it here.</p>
          </Show>

          <div class="playhead" style={{ left: `${state.timeToX(state.playhead())}px` }} />
        </div>
      </div>
    </section>
  )
}

function LaneView(props: { lane: Lane; label: string; state: AppState; height: number }) {
  const state = props.state
  const clips = () => laneOf(state.project, props.lane)

  return (
    <div class="lane" data-lane={props.lane} style={{ height: `${props.height}px` }}>
      <span class="lane-label">{props.label}</span>
      <For each={clips()}>
        {(clip, index) => <ClipView clip={clip} index={index()} state={state} lane={props.lane} height={props.height - 12} />}
      </For>
    </div>
  )
}

function ClipView(props: { clip: Clip; index: number; state: AppState; lane: Lane; height: number }) {
  const state = props.state
  const rect = () => state.clipRect(props.lane, props.index)
  const asset = () => state.getAsset(props.clip.assetId)
  const isSelected = () => state.selected() === props.clip.id
  const linked = () => (props.clip.linkId ? state.selectedPartner()?.linkId === props.clip.linkId : false)

  return (
    <div
      class="clip"
      classList={{ selected: isSelected(), linked: linked() }}
      data-clip-index={props.index}
      style={{
        left: `${rect().left}px`,
        width: `${Math.max(2, rect().width)}px`,
        height: `${props.height}px`,
        '--tint': props.lane === 'video' ? 'hsl(215 65% 52%)' : 'hsl(160 60% 42%)',
      }}
      title={`${asset()?.name ?? 'missing'} — ${props.clip.in.toFixed(2)}s → ${props.clip.out.toFixed(2)}s`}
    >
      <div class="handle in" data-handle="in" data-index={props.index} style={{ width: `${HANDLE}px` }} />

      <Show when={props.lane === 'audio'}>
        <Waveform clip={props.clip} state={state} />
      </Show>

      <span class="clip-name">{asset()?.name ?? '?'}</span>

      <Show when={linked()}>
        <span class="link-badge" title="Linked to its pair — edits apply to both">⛓</span>
      </Show>

      <div class="handle out" data-handle="out" data-index={props.index} style={{ width: `${HANDLE}px` }} />
    </div>
  )
}

/**
 * The waveform.
 *
 * Peaks are computed once per asset and cached in the store; this only draws.
 * It redraws on zoom and on resize, never per frame — a canvas repaint per
 * playhead move would make scrubbing feel like wading.
 */
function Waveform(props: { clip: Clip; state: AppState }) {
  const state = props.state
  let canvas!: HTMLCanvasElement

  const peaks = (): Peak[] | undefined => state.peaksBy[props.clip.assetId]

  function paint(): void {
    const list = peaks()
    if (!list || !canvas) return
    const width = Math.max(1, Math.round(rectWidth()))
    const height = Math.max(1, Math.round(canvas.clientHeight || 40))

    if (canvas.width !== width) canvas.width = width
    if (canvas.height !== height) canvas.height = height

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.clearRect(0, 0, width, height)
    drawPeaks(ctx, list, state.getAsset(props.clip.assetId)?.duration ?? 1, {
      startTime: props.clip.in,
      endTime: props.clip.out,
      width,
      height,
      color: props.clip.muted ? 'rgba(210,153,34,0.55)' : 'rgba(255,255,255,0.85)',
    })
  }

  function rectWidth(): number {
    return Math.max(1, props.clip.out - props.clip.in) * state.zoom()
  }

  onMount(paint)
  // Re-paint when the peaks arrive, the clip is trimmed, or the zoom changes.
  createEffect(() => {
    peaks()
    props.clip.in
    props.clip.out
    props.clip.muted
    state.zoom()
    paint()
  })

  return <canvas class="waveform" ref={canvas} style={{ width: `${rectWidth()}px` }} />
}

function formatTick(t: number): string {
  if (t < 1) return `${t.toFixed(t < 0.25 ? 2 : 1)}s`
  const m = Math.floor(t / 60)
  const s = Math.round(t % 60)
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`
}

void log
