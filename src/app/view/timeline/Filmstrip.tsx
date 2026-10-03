/**
 * A clip's filmstrip.
 *
 * One frame off the front of the clip, tiled across its width, dimmed so the
 * tint and the label still read through. It is the difference between "a blue
 * rectangle" and "the shot I was looking for" when a timeline has twenty clips.
 *
 * The decode is the same sink the preview uses. Frames are cached by
 * `asset@time` as `ImageBitmap`s — a bitmap survives the sink reusing its
 * canvas, and a zoom change repaints from the cache instead of decoding again.
 */

import { createEffect, onCleanup, onMount } from 'solid-js'
import type { Clip } from '../../../model/project.js'
import type { AppState } from '../../store/state.js'

/** Decoded frames, keyed `assetId@seconds`. Bounded so a long session cannot grow forever. */
const frames = new Map<string, ImageBitmap>()
const FRAME_CACHE_MAX = 80

async function frameFor(state: AppState, assetId: string, time: number): Promise<ImageBitmap | null> {
  const key = `${assetId}@${time.toFixed(2)}`
  const hit = frames.get(key)
  if (hit) return hit
  const sink = state.library.get(assetId)?.videoSink
  if (!sink) return null
  const wrapped = await sink.getCanvas(time)
  if (!wrapped) return null
  const bitmap = await createImageBitmap(wrapped.canvas)
  if (frames.size >= FRAME_CACHE_MAX) {
    const oldest = frames.keys().next().value
    if (oldest !== undefined) {
      frames.get(oldest)?.close()
      frames.delete(oldest)
    }
  }
  frames.set(key, bitmap)
  return bitmap
}

export function Filmstrip(props: { clip: Clip; state: AppState; height: number }) {
  let canvas: HTMLCanvasElement | undefined
  let disposed = false
  onCleanup(() => {
    disposed = true
  })

  const width = (): number => Math.max(1, Math.round((props.clip.out - props.clip.in) * props.state.zoom()))

  async function paint(): Promise<void> {
    if (!canvas) return
    const w = width()
    const h = Math.max(1, Math.round(props.height))
    if (canvas.width !== w) canvas.width = w
    if (canvas.height !== h) canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, w, h)

    // A hair into the clip, because `getCanvas(0)` can legitimately return null
    // before a track's first timestamp.
    const bitmap = await frameFor(props.state, props.clip.assetId, props.clip.in + 0.05)
    if (!bitmap || disposed || !canvas) return

    const tileW = Math.max(24, Math.round((h * bitmap.width) / bitmap.height))
    ctx.globalAlpha = 0.5
    for (let x = 0; x < w; x += tileW) ctx.drawImage(bitmap, x, 0, tileW, h)
    ctx.globalAlpha = 1
  }

  onMount(paint)
  // Repaint on trim and zoom; the frame itself comes from the cache.
  createEffect(() => {
    props.clip.in
    props.clip.out
    props.state.zoom()
    void paint()
  })

  return <canvas ref={canvas} class="pointer-events-none absolute inset-0" style={{ width: `${width()}px` }} />
}
