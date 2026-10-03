/**
 * Transport: the playhead, playback, and everything derived from them.
 *
 * The playhead is driven by the *audio* clock wherever one exists, because the
 * eye forgives a picture that lags slightly far more than it forgives sound
 * that drifts. `performance.now()` is only the fallback for when there is no
 * audio track to ask.
 *
 * Wall-clock anchoring exists for the same reason as the audio clock: a fallback
 * that accumulates `+= frameDuration` drifts, and a playhead that lies about
 * where it is makes every other measurement on screen wrong.
 */

import { createSignal, type Accessor } from 'solid-js'

import { AudioEngine } from '../../audio/audio-engine.js'
import {
  clipAtLane,
  findClip,
  isLinked,
  linkedPartner,
  projectDuration,
  type Asset,
  type Clip,
  type ClipId,
  type Project,
} from '../../model/project.js'
import type { Selection } from './selection.js'

/** Output frame rate. Fixed, because the export muxer wants a constant rate. */
const OUTPUT_FPS = 30

export interface TransportDeps {
  project: Project
  audio: AudioEngine
  selection: Selection
  notify: (kind: 'info' | 'warn' | 'error', text: string) => void
  /** Whether the bin holds anything — used to phrase an empty-timeline notice. */
  hasImportedFiles: () => boolean
  /** Apply a transform, owned by the edits slice. */
  setTransform: (clipId: ClipId, transform: Clip['transform']) => void
}

export interface Transport {
  playhead: Accessor<number>
  playing: Accessor<boolean>
  seek: (time: number) => void
  togglePlay: () => Promise<void>
  /**
   * Stop playback without moving the playhead.
   *
   * Exposed raw because scrubbing while playing must halt playback — that is
   * what a user dragging the ruler expects, and it is not something `seek` can
   * decide on their behalf.
   *
   * "Raw" means *unguarded by intent*, not *half-applied*: this stops the engine
   * and clears the flag together, because a caller that clears one without the
   * other is the bug this function exists to prevent.
   */
  setPlaying: (value: boolean) => void
  /**
   * Pull the playhead back inside the timeline, if the project just shrank.
   *
   * Not called by the UI. `setProject` calls it, because that is the only place
   * that knows a change is coming — the same reason the selection is pruned
   * there rather than by each caller.
   */
  clampPlayhead: () => void
  advanceClock: () => void
  step: (frames: number) => void
  resetView: () => void
  setTransformActive: (transform: Clip['transform']) => void
  duration: () => number
  outputFps: () => number
  selectedClip: () => Clip | null
  findClipById: (id: ClipId) => Clip | null
  selectedIsLinked: () => boolean
  selectedPartner: () => Clip | null
}

/**
 * The frame rate playback steps by.
 *
 * Not `OUTPUT_FPS`. That constant is fixed at 30 because the export muxer wants a
 * constant rate, which is true and irrelevant to stepping a playhead: on a 24 fps
 * source `←`/`→` moved 0.8 of a frame, so repeated stepping walked off frame
 * boundaries and the arrow keys stopped landing on distinguishable frames.
 *
 * The source's own rate, because the frames being stepped through are the
 * source's. **A VFR asset falls back to the output rate**, and so does anything
 * with no frame rate to speak of — its average is meaningless (3.75 fps for a
 * screen recording), which `settingsFor` already declines to export at.
 */
export function frameRateFor(asset: Asset | undefined): number {
  if (!asset || asset.variableFrameRate) return OUTPUT_FPS
  const fps = Math.round(asset.frameRate)
  return fps > 0 ? fps : OUTPUT_FPS
}

export function createTransport(deps: TransportDeps): Transport {
  const { project, audio, selection: sel, notify, hasImportedFiles, setTransform } = deps

  const [playhead, setPlayhead] = createSignal(0)
  const [playing, setPlayingFlag] = createSignal(false)

  /**
   * The fallback clock, for a timeline with no audio to follow.
   *
   * Anchored to a single `performance.now()` reading rather than accumulating a
   * frame duration per tick, because `1/30` is not representable and the sum
   * drifts. See docs/data-model.md on integers at the boundaries.
   */
  let wallClockAnchor: { at: number; from: number; runStart: number | null } | null = null

  const duration = (): number => projectDuration(project)
  /** The *output* rate. Playback steps by the source's — see `frameRateFor`. */
  const outputFps = (): number => OUTPUT_FPS

  /**
   * Stop or start playback, keeping the flag and the engine in step.
   *
   * These are two different pieces of state — a signal and an AudioContext — and
   * until now only `togglePlay` knew that: it was the single caller that stopped
   * the engine as well as clearing the flag. Every other route in — a click on
   * the timeline, the end-of-timeline check in the playback clock — cleared the
   * flag and left the sound running, so the picture froze and the audio did not.
   *
   * So the rule lives here instead. One function owns both halves, which is the
   * only way to make "stopped" mean stopped for a caller that has no reason to
   * know there are two things to stop.
   */
  function setPlaying(value: boolean): void {
    // Unconditional rather than `if (playing())`. A guard keyed on the flag is
    // the same assumption that caused this bug — the thing being fixed is that
    // the flag and the engine can disagree — and `stop()` on an idle engine is
    // already a no-op.
    if (!value) audio.stop()
    setPlayingFlag(value)
  }

  /**
   * Pull the playhead back inside the timeline.
   *
   * The project can shrink under a stationary playhead: a delete, clearing a
   * lane, dropping a file whose clips were the tail. `seek` clamps and
   * `advanceClock` clamps, but **neither of them runs when the lanes change**,
   * so the playhead was left at 20s on a timeline of nothing — drawn at x=1600
   * inside a 600px track, so clipped away and unreachable by dragging.
   *
   * Symmetric with `seek`'s clamp deliberately. It is the same statement about
   * the same invariant, and having it written in two places is how the playhead
   * came to outlive the edit.
   */
  function clampPlayhead(): void {
    const at = playhead()
    const end = duration()
    // Only write when actually out of range. `setProject` runs after every edit,
    // and writing an unchanged value would dirty every reader of the playhead —
    // including the preview's redraw effect — for nothing.
    if (at > end) setPlayhead(end)
    else if (at < 0) setPlayhead(0)
  }

  const selectedClip = (): Clip | null => {
    const id = sel.primary()
    return id ? (findClip(project, id)?.clip ?? null) : null
  }
  const findClipById = (id: ClipId): Clip | null => findClip(project, id)?.clip ?? null
  const selectedIsLinked = (): boolean => {
    const clip = selectedClip()
    return clip ? isLinked(project, clip) : false
  }
  const selectedPartner = (): Clip | null => {
    const clip = selectedClip()
    return clip ? linkedPartner(project, clip) : null
  }

  function seek(time: number): void {
    const clamped = Math.max(0, Math.min(time, duration()))
    if (playing()) {
      void restartAt(clamped)
      return
    }
    setPlayhead(clamped)
  }

  async function restartAt(time: number): Promise<void> {
    audio.stop()
    const runStart = await audio.play(project, time)
    // The `await` is a window in which the user can stop: `seek` is fire-and-
    // forget (`void restartAt(...)`), so a click on the timeline clears the flag
    // while this is still waiting for the engine to start. Without this guard the
    // run that was just cancelled lands afterwards and plays on a transport that
    // says it is stopped — the same "the flag and the sound disagree" bug, one
    // step later than the one `setPlaying` fixes.
    if (!playing()) {
      audio.stop()
      return
    }
    wallClockAnchor = { at: performance.now(), from: time, runStart: runStart ?? null }
    setPlayhead(time)
  }

  async function togglePlay(): Promise<void> {
    if (project.video.length === 0 && project.audio.length === 0) {
      notify(
        'warn',
        hasImportedFiles()
          ? 'Add a clip to the timeline first — double-click a file under Media.'
          : 'Drop a video file to get started.',
      )
      return
    }

    if (playing()) {
      // Where the audio actually got to, not where we last drew the playhead.
      const at = audio.now() ?? playhead()
      // Read the position first, then stop — `setPlaying` owns stopping the
      // engine, which is what `audio.now()` is asking about.
      setPlaying(false)
      setPlayhead(at)
      return
    }

    let from = playhead()
    if (from >= duration() - 0.01) from = 0

    await audio.unlock()
    const runStart = await audio.play(project, from)
    wallClockAnchor = { at: performance.now(), from, runStart: runStart ?? null }
    if (from !== playhead()) setPlayhead(from)
    setPlaying(true)
  }

  function advanceClock(): void {
    if (!playing()) return
    // Prefer the audio clock: it is the one the viewer is listening to.
    const audioTime = audio.now()
    if (audioTime !== null) {
      setPlayhead(Math.max(0, Math.min(audioTime, duration())))
      return
    }
    if (wallClockAnchor) {
      const elapsed = (performance.now() - wallClockAnchor.at) / 1000
      setPlayhead(Math.min(wallClockAnchor.from + elapsed, duration()))
    }
  }

  function step(frames: number): void {
    // The clip under the playhead is the one whose frames we are stepping through;
    // a selected clip is the fallback for stepping through something not yet
    // reached, and `OUTPUT_FPS` when there is nothing to step through at all.
    const clip = clipAtLane(project.video, playhead())?.clip ?? selectedClip()
    const fps = frameRateFor(clip ? project.assets[clip.assetId] : undefined)
    seek(playhead() + frames / fps)
  }

  function resetView(): void {
    sel.clear()
    notify('info', 'View reset.')
  }

  /** Transform the selected clip, or failing that whatever is under the playhead. */
  function setTransformActive(transform: Clip['transform']): void {
    const clip = selectedClip() ?? clipAtLane(project.video, playhead())?.clip ?? null
    if (!clip) {
      notify('warn', 'Select a clip first.')
      return
    }
    setTransform(clip.id, transform)
  }

  return {
    playhead,
    playing,
    seek,
    togglePlay,
    setPlaying,
    clampPlayhead,
    advanceClock,
    step,
    resetView,
    setTransformActive,
    duration,
    outputFps,
    selectedClip,
    findClipById,
    selectedIsLinked,
    selectedPartner,
  }
}
