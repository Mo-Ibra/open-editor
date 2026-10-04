/**
 * One small thumbnail per asset, shared by everything that shows one.
 *
 * The media bin and the timeline filmstrip both want a frame off the front of a
 * file. Doing that independently means two decodes per asset, and doing it at
 * full resolution means hundreds of megabytes of bitmaps. This is the single
 * cheap path they both use:
 *
 * - **one decode per asset**, deduped while in flight and cached as a small
 *   JPEG data URL (~kB, not MB);
 * - **downscaled** to `THUMB_HEIGHT` before it is ever held;
 * - **serialized** to a couple at a time, because the decoder is shared with the
 *   preview and a burst of them is what made a big project stutter.
 *
 * The result is a `string` a caller can put in an `<img src>` or a CSS
 * `background-image`, neither of which costs anything to display.
 */

import type { AppState } from '../../store/state.js'

/** Target height of the generated thumbnail, in pixels. */
const THUMB_HEIGHT = 96
/** How many thumbnails to keep. Each is a few kB. */
const CACHE_MAX = 160
/** Decodes in flight at once. Two keeps one slot free for the preview. */
const MAX_CONCURRENT = 2

const resolved = new Map<string, string>()
const inFlight = new Map<string, Promise<string | null>>()

let active = 0
const waiting: (() => void)[] = []

async function withSlot<T>(job: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiting.push(resolve))
  active += 1
  try {
    return await job()
  } finally {
    active -= 1
    waiting.shift()?.()
  }
}

/** A small `data:image/jpeg` frame for `assetId`, or null if it cannot be made. */
export function thumbnailFor(state: AppState, assetId: string): Promise<string | null> {
  const done = resolved.get(assetId)
  if (done) return Promise.resolve(done)
  const pending = inFlight.get(assetId)
  if (pending) return pending

  const job = withSlot(async () => {
    try {
      const entry = state.library.get(assetId)
      const sink = entry?.videoSink
      if (!sink) return null
      const duration = entry.asset.duration
      // A little way in, so a black leader frame is not the whole thumbnail.
      const time = Math.min(Math.max(0.05, duration * 0.1), Math.max(0.05, duration - 0.05))
      const wrapped = await sink.getCanvas(time)
      if (!wrapped) return null
      const srcW = wrapped.canvas.width
      const srcH = wrapped.canvas.height
      if (!srcW || !srcH) return null

      const height = THUMB_HEIGHT
      const width = Math.max(1, Math.round((height * srcW) / srcH))
      const bitmap = await createImageBitmap(wrapped.canvas, {
        resizeWidth: width,
        resizeHeight: height,
        resizeQuality: 'low',
      })
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        bitmap.close()
        return null
      }
      ctx.drawImage(bitmap, 0, 0, width, height)
      bitmap.close()
      const url = canvas.toDataURL('image/jpeg', 0.6)

      if (resolved.size >= CACHE_MAX) {
        const oldest = resolved.keys().next().value
        if (oldest !== undefined) resolved.delete(oldest)
      }
      resolved.set(assetId, url)
      return url
    } catch {
      // A thumbnail is decoration; a failed decode just leaves the tint.
      return null
    }
  })

  inFlight.set(assetId, job)
  void job.finally(() => inFlight.delete(assetId))
  return job
}

/** Drop the cache — for tests, or when a project's media is replaced. */
export function clearThumbnails(): void {
  resolved.clear()
  inFlight.clear()
}
