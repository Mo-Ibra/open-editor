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
    const lane = target.closest('[data-lane]')?.getAttribute('data-lane') as Lane | undefined
    track.setPointerCapture(event.pointerId)

    // Every click positions the playhead, wherever it lands: ruler, empty lane,
    // or on top of a clip. Position first, gesture second — a press is a seek
    // that may turn into a drag, not one or the other.
    const x = localX(event)
    if (state.playing()) state.setPlaying(false)
    state.seek(state.xToTime(x))

    if (target.dataset.handle === 'in' || target.dataset.handle === 'out') {
      if (!lane) return
      const index = Number(target.dataset.index)
      drag = { kind: target.dataset.handle === 'in' ? 'trim-in' : 'trim-out', lane, index }
      return
    }

    if (target.dataset.clipIndex !== undefined && lane) {
      const index = Number(target.dataset.clipIndex)
      const clip = laneOf(state.project, lane)[index]
      if (!clip) return
      state.setSelected(clip.id)
      drag = { kind: 'move', lane, index, grabOffset: state.xToTime(x) - laneStart(lane, index) }
      return
    }

    // Ruler or empty lane: a plain seek, and dragging keeps scrubbing.
    drag = { kind: 'playhead' }
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
    <section class="flex h-[236px] shrink-0 flex-col border-t border-line bg-panel">
      {/* toolbar */}
      <div class="flex h-9 shrink-0 items-center gap-1.5 border-b border-line-soft px-2">
        <button class="btn" onClick={() => state.splitAt(state.playhead())} disabled={!anyClips()}>
          Split
        </button>
        <button class="btn" onClick={() => state.deleteSelected()} disabled={!state.selected()}>
          Delete
        </button>
        <button
          class="btn"
          disabled={!state.selectedIsLinked()}
          onClick={() => state.breakSelectedLink()}
          title="Cut this clip and its pair apart, so they edit independently"
        >
          {state.selectedIsLinked() ? 'Break link' : 'unlinked'}
        </button>

        <span class="mx-1 h-5 w-px bg-line" />

        <Show when={state.selectedClip()}>
          {(clip) => (
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
                <button class="btn !py-0.5" onClick={() => state.toggleMute(clip().id)}>
                  {clip().muted ? 'muted' : 'live'}
                </button>
              </label>
            </Show>
          )}
        </Show>

        <span class="flex-1" />

        <span class="timecode pr-1 text-[10.5px] text-muted">
          {state.project.video.length} video · {state.project.audio.length} audio
        </span>
      </div>

      {/* ruler + lanes */}
      <div class="min-h-0 flex-1 overflow-auto">
        <div
          ref={track}
          class="relative min-h-full select-none touch-none"
          style={{ width: `${contentWidth()}px` }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div class="sticky top-0 h-6 border-b border-line bg-raised/80 backdrop-blur">
            <For each={ticks()}>
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

          <LaneView lane="video" label="video" state={state} height={56} />
          <LaneView lane="audio" label="audio" state={state} height={62} />

          <Show when={!anyClips()}>
            <p class="pointer-events-none absolute inset-x-0 top-16 text-center text-[11.5px] text-muted">
              Click a file in Media to add it here.
            </p>
          </Show>

          <div
            class="pointer-events-none absolute bottom-0 top-0 z-20 w-px bg-accent"
            style={{ left: `${state.timeToX(state.playhead())}px` }}
          >
            <span class="absolute -left-[5px] top-0 border-x-[5px] border-t-[6px] border-x-transparent border-t-accent" />
          </div>
        </div>
      </div>
    </section>
  )

  function anyClips(): boolean {
    return state.project.video.length > 0 || state.project.audio.length > 0
  }
}

function LaneView(props: { lane: Lane; label: string; state: AppState; height: number }) {
  const state = props.state
  const clips = () => laneOf(state.project, props.lane)

  return (
    <div
      class="relative border-b border-line-soft last:border-b-0"
      data-lane={props.lane}
      style={{ height: `${props.height}px` }}
    >
      <span class="panel-label pointer-events-none absolute right-2 top-1.5 z-10">{props.label}</span>
      <For each={clips()}>
        {(clip, index) => (
          <ClipView clip={clip} index={index()} state={state} lane={props.lane} height={props.height - 12} />
        )}
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
      class="group absolute top-1.5 cursor-grab overflow-hidden rounded-md border transition-shadow active:cursor-grabbing"
      classList={{
        selected: isSelected(),
        'border-[#ffffff]/70 shadow-[0_0_0_1px_#ffffff,0_4px_14px_-4px_#000]': isSelected(),
        'border-transparent': !isSelected(),
      }}
      data-clip-index={props.index}
      style={{
        left: `${rect().left}px`,
        width: `${Math.max(2, rect().width)}px`,
        height: `${props.height}px`,
        // Tint is a low-chroma wash; the waveform and the picture carry the colour.
        'background-color': props.lane === 'video' ? '#1b2c47' : '#16342a',
        'border-color': isSelected()
          ? 'transparent'
          : props.lane === 'video'
            ? '#2a4674'
            : '#1f5541',
      }}
      title={`${asset()?.name ?? 'missing'} — ${props.clip.in.toFixed(2)}s → ${props.clip.out.toFixed(2)}s`}
    >
      <div
        class="absolute inset-y-0 left-0 z-20 cursor-ew-resize bg-white/0 transition-colors group-hover:bg-white/10"
        style={{ width: `${HANDLE}px` }}
        data-handle="in"
        data-index={props.index}
      />

      <Show when={props.lane === 'audio'}>
        <Waveform clip={props.clip} state={state} />
      </Show>

      <span class="pointer-events-none absolute left-2 top-1 z-10 max-w-[calc(100%-34px)] truncate text-[10.5px] text-fg/90 [text-shadow:0_1px_2px_#000a]">
        {asset()?.name ?? '?'}
      </span>

      <Show when={linked()}>
        <span
          class="pointer-events-none absolute right-1.5 top-0.5 z-10 text-[9px] text-fg/60"
          title="Linked to its pair — edits apply to both"
        >
          ⛓
        </span>
      </Show>

      <div
        class="absolute inset-y-0 right-0 z-20 cursor-ew-resize bg-white/0 transition-colors group-hover:bg-white/10"
        style={{ width: `${HANDLE}px` }}
        data-handle="out"
        data-index={props.index}
      />
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

  return <canvas ref={canvas} class="pointer-events-none absolute inset-0 size-full" style={{ width: `${rectWidth()}px` }} />
}

function formatTick(t: number): string {
  if (t < 1) return `${t.toFixed(t < 0.25 ? 2 : 1)}s`
  const m = Math.floor(t / 60)
  const s = Math.round(t % 60)
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`
}

void log
