/**
 * The waveform.
 *
 * Peaks are computed once per asset and cached in the store; this only draws.
 * It redraws on zoom and on resize, never per frame — a canvas repaint per
 * playhead move would make scrubbing feel like wading.
 */

import { createEffect, onMount } from 'solid-js'
import { drawPeaks, type Peak } from '../../../media/peaks.js'
import type { Clip } from '../../../model/project.js'
import type { AppState } from '../../store/state.js'

export function Waveform(props: { clip: Clip; state: AppState }) {
  const state = props.state
  let canvas!: HTMLCanvasElement

  const peaks = (): Peak[] | undefined => state.peaksBy[props.clip.assetId]
  const rectWidth = (): number => Math.max(1, props.clip.out - props.clip.in) * state.zoom()

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
