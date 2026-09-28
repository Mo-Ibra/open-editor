/**
 * The playback clock.
 *
 * **This timer does not own the time.** It only *polls* it: `advanceClock`
 * reads the AudioContext clock, which is the reference, and falls back to
 * wall-clock only if audio never started. A JS timer is not accurate enough
 * to be the timebase for a ten-minute edit — it drifts, and drift here is
 * exactly A/V desync.
 *
 * **And it is deliberately not `requestAnimationFrame`.** rAF is suspended
 * whenever the page is not being painted: a background tab, a minimised window,
 * a devtools panel that took focus. A video editor is exactly the app where the
 * user has devtools open, so making rAF load-bearing for the clock means
 * playback silently does nothing — `playing` flips true, no frame ever arrives,
 * and the symptom is indistinguishable from a broken button. Timers are
 * throttled when hidden, but they still fire, and every step is computed from
 * `performance.now()` rather than accumulated, so playback resumes in step with
 * real time.
 *
 * The 120Hz poll is faster than the display and only exists so the playhead
 * looks smooth; it is not a precision requirement.
 */

import { createEffect, createSignal, onCleanup, type Accessor } from 'solid-js'
import type { AppState } from '../../store/state.js'

/** How often the clock is polled. Faster than any display, deliberately. */
const POLL_HZ = 120

export interface PlaybackClock {
  /** Ticks since playback started. Drives the "playing N" readout. */
  ticks: Accessor<number>
}

export function usePlaybackClock(state: AppState): PlaybackClock {
  const [ticks, setTicks] = createSignal(0)
  let timer: ReturnType<typeof setInterval> | undefined

  function stop(): void {
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }

  createEffect(() => {
    if (!state.playing()) {
      stop()
      setTicks(0)
      return
    }

    timer = setInterval(() => {
      const previous = state.playhead()
      state.advanceClock()

      // Running past the end stops rather than freezing on the last frame.
      if (state.playhead() >= state.duration() && state.playing()) {
        state.seek(state.duration())
        state.setPlaying(false)
        return
      }
      if (state.playhead() !== previous) setTicks((n) => n + 1)
    }, 1000 / POLL_HZ)
  })

  onCleanup(stop)

  // Being hidden throttles timers to roughly 1Hz, so playback becomes a
  // slideshow rather than stopping. Say so, because "it went choppy" reads as
  // a bug and gets reported as one.
  const warn = (): void => {
    if (state.playing() && document.hidden) {
      console.warn('[transport] tab hidden — timers throttled to ~1 Hz, playback will stutter')
    }
  }
  document.addEventListener('visibilitychange', warn)
  onCleanup(() => document.removeEventListener('visibilitychange', warn))

  return { ticks }
}
