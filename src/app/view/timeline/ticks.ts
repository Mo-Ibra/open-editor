/**
 * Tick spacing and labels for the ruler.
 *
 * In a `.ts` file, not a `.tsx` one, and that is not tidiness: the test runner
 * strips types with Node's own loader, which cannot load `.tsx` at all. Pure
 * logic placed beside a component is therefore untested by construction — so it
 * lives here, and `Ruler.tsx` is left with nothing but markup.
 */

/** Minimum pixels between ticks, so the labels never collide. */
const MIN_GAP = 90

/** 0.04 is 24fps; 1800 is 30 minutes. */
const TICK_INTERVALS = [0.04, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800]

/**
 * The first interval that leaves `MIN_GAP` pixels between labels, so zooming
 * changes the *units* rather than the density. Otherwise the ruler becomes an
 * unreadable comb at high zoom.
 */
export function tickInterval(zoom: number): number {
  return TICK_INTERVALS.find((i) => i * zoom >= MIN_GAP) ?? TICK_INTERVALS.at(-1)!
}

export function ticks(duration: number, zoom: number): number[] {
  if (duration <= 0) return []
  const step = tickInterval(zoom)
  const out: number[] = []
  // A multiplied index, never `t += step`. 0.04 is not representable, and
  // accumulating it drifts — a whole frame of error over a long timeline.
  for (let n = 0; n * step <= duration + 1e-9; n += 1) out.push(Number((n * step).toFixed(4)))
  return out
}

export function formatTick(t: number): string {
  if (t < 1) return `${t.toFixed(t < 0.25 ? 2 : 1)}s`
  const m = Math.floor(t / 60)
  const s = Math.round(t % 60)
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`
}
