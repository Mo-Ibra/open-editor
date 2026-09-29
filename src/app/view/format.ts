/**
 * Display formatting.
 *
 * Its own file because the transport bar and the status bar both need it, and
 * because a private copy inside a component is how two places end up showing
 * different times for the same instant.
 */

/** `m:ss.mm`, clamped at zero. Two decimals, because a frame is 1/25th. */
export function formatTime(seconds: number): string {
  const s = Math.max(0, seconds)
  const m = Math.floor(s / 60)
  const rest = s - m * 60
  return `${m}:${rest.toFixed(2).padStart(5, '0')}`
}
