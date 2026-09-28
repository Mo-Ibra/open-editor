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

import { AudioEngine } from '../audio/audio-engine.js'
import {
  clipAtLane,
  findClip,
  isLinked,
  linkedPartner,
  projectDuration,
  type Clip,
  type ClipId,
  type Project,
} from '../model/project.js'
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
   */
  setPlaying: (value: boolean) => void
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

export function createTransport(deps: TransportDeps): Transport {
  const { project, audio, selection: sel, notify, hasImportedFiles, setTransform } = deps

  const [playhead, setPlayhead] = createSignal(0)
  const [playing, setPlaying] = createSignal(false)

  /**
   * The fallback clock, for a timeline with no audio to follow.
   *
   * Anchored to a single `performance.now()` reading rather than accumulating a
   * frame duration per tick, because `1/30` is not representable and the sum
   * drifts. See docs/data-model.md on integers at the boundaries.
   */
  let wallClockAnchor: { at: number; from: number; runStart: number | null } | null = null

  const duration = (): number => projectDuration(project)
  const outputFps = (): number => OUTPUT_FPS

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
      setPlaying(false)
      audio.stop()
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
    seek(playhead() + frames / outputFps())
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
