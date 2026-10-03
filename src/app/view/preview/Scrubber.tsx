/**
 * The seek bar under the picture.
 *
 * A full-width progress bar that is also the fastest way to move the playhead:
 * click anywhere to jump, drag to scrub. The canvas itself is scrubbable, but a
 * picture with no visible track gives no sense of the current position or how
 * much is left, so this is the affordance people actually reach for.
 *
 * Pure presentation over `state.seek`; the transport does not own any position
 * of its own, so the bar and the picture can never disagree.
 */

import type { AppState } from '../../store/state.js'

export function Scrubber(props: { state: AppState }) {
  let track!: HTMLDivElement

  const duration = (): number => props.state.duration()
  const hasMedia = (): boolean => duration() > 0
  const fraction = (): number => {
    const d = duration()
    if (d <= 0) return 0
    return Math.min(1, Math.max(0, props.state.playhead() / d))
  }

  function seekTo(clientX: number): void {
    const d = duration()
    const rect = track.getBoundingClientRect()
    if (d <= 0 || rect.width === 0) return
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    props.state.seek(frac * d)
  }

  return (
    <div
      ref={track}
      class="group relative h-2 w-full shrink-0 select-none"
      classList={{ 'cursor-pointer': hasMedia(), 'cursor-default': !hasMedia() }}
      data-scrub
      role="slider"
      aria-label="Playhead"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration() * 100) / 100}
      aria-valuenow={Math.round(props.state.playhead() * 100) / 100}
      onPointerDown={(e) => {
        if (!hasMedia()) return
        e.currentTarget.setPointerCapture(e.pointerId)
        seekTo(e.clientX)
      }}
      onPointerMove={(e) => {
        // Only while the button is held: a hover must never move the playhead.
        if (e.buttons === 1) seekTo(e.clientX)
      }}
    >
      <div class="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-line" />
      <div
        class="absolute top-1/2 left-0 h-1 -translate-y-1/2 rounded-full bg-accent"
        style={{ width: `${fraction() * 100}%` }}
      />
      <div
        class="pointer-events-none absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-panel bg-accent opacity-0 shadow transition-opacity group-hover:opacity-100 group-active:opacity-100"
        style={{ left: `${fraction() * 100}%` }}
      />
    </div>
  )
}
