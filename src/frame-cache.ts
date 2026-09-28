/**
 * Frame cache for preview scrubbing.
 *
 * Split out from `library.ts` so it has no dependency on mediabunny. Pure logic
 * deserves to be unit-testable, and this is pure logic.
 */

/**
 * Frame cache for preview scrubbing.
 *
 * Scrubbing a timeline asks for the same source time dozens of times per
 * second. Asking the decoder each time is what made the Phase 0 harness slow
 * (PLAN.md R2). Holding the last frame and reusing it when the requested time
 * still lands inside it turns a drag from a stutter into a glide.
 *
 * A ring buffer rather than one frame, because a user dragging a trim handle
 * sweeps backwards and forwards across the same few frames.
 */
export class FrameCache {
  static readonly CAPACITY = 24

  #frames: { timestamp: number; duration: number; canvas: HTMLCanvasElement | OffscreenCanvas }[] = []
  #index = 0

  clear(): void {
    this.#frames = []
    this.#index = 0
  }

  /** The frame covering `time`, if we happen to still hold it. */
  find(time: number): { timestamp: number; duration: number; canvas: HTMLCanvasElement | OffscreenCanvas } | undefined {
    for (const frame of this.#frames) {
      if (time >= frame.timestamp && time < frame.timestamp + frame.duration) return frame
    }
    return undefined
  }

  put(frame: { timestamp: number; duration: number; canvas: HTMLCanvasElement | OffscreenCanvas }): void {
    if (this.#frames.length < FrameCache.CAPACITY) {
      this.#frames.push(frame)
      return
    }
    this.#frames[this.#index] = frame
    this.#index = (this.#index + 1) % FrameCache.CAPACITY
  }

  get size(): number {
    return this.#frames.length
  }
}
