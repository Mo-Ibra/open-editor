/**
 * Application state and every action that can change it.
 *
 * One store, one place. Components read from it and call actions on it; they
 * never mutate the project directly. That is what makes undo a two-line
 * feature rather than a subsystem.
 */

import { batch, createSignal } from 'solid-js'
import { createStore, unwrap } from 'solid-js/store'
import { FrameCache } from './frame-cache.js'
import { MediaLibrary, type LibraryEntry } from './library.js'
import { AudioEngine } from './audio-engine.js'
import { computePeaks, type Peak } from './peaks.js'
import { log } from './debug.js'
import {
  appendAsset,
  breakLink,
  clipAtLane,
  clipDuration,
  clipStart,
  emptyProject,
  findClip,
  isLinked,
  laneDuration,
  laneOf,
  linkedPartner,
  moveClip,
  newId,
  projectDuration,
  removeClip,
  setClipGain as applyGain,
  setTransform as applyTransform,
  splitLinked,
  toggleMute as applyMute,
  trimClip as applyTrim,
  type AssetId,
  type Clip,
  type ClipId,
  type Lane,
  type Project,
} from './project.js'

const HISTORY_LIMIT = 100

export interface Notice {
  kind: 'info' | 'warn' | 'error'
  text: string
}

export function createAppState() {
  const library = new MediaLibrary()

  const [project, setProject] = createStore<Project>(emptyProject())
  const [playhead, setPlayhead] = createSignal(0)
  const [playing, setPlaying] = createSignal(false)
  const [selected, setSelected] = createSignal<ClipId | null>(null)
  const [zoom, setZoomLevel] = createSignal(80) // pixels per second
  const [notices, setNotices] = createSignal<Notice[]>([])
  const [loading, setLoading] = createSignal(false)
  /** Peaks per asset, computed once and reused. The waveform redraws on every
   *  playhead move, so recomputing would make scrubbing unusable. */
  const [peaksBy, setPeaksBy] = createStore<Record<string, Peak[]>>({})

  /** History entries are the two lanes, without assets — pointers are all an
   *  edit can change, and it keeps a snapshot to a few hundred bytes. */
  type Lanes = { video: Clip[]; audio: Clip[] }
  const [past, setPast] = createSignal<Lanes[]>([])
  const [future, setFuture] = createSignal<Lanes[]>([])

  const frameCache = new FrameCache()

  const audio = new AudioEngine({
    library,
    onError: (message) => notify('error', message),
  })

  function notify(kind: Notice['kind'], text: string): void {
    setNotices((prev) => [...prev.slice(-4), { kind, text }])
    if (kind !== 'error') setTimeout(() => setNotices((prev) => prev.slice(0, -1)), 6000)
  }

  // --- history ------------------------------------------------------------

  function snapshot(): Lanes {
    return { video: unwrap(project).video, audio: unwrap(project).audio }
  }

  function commit(): void {
    const current = snapshot()
    setPast((prev) => [...prev.slice(-(HISTORY_LIMIT - 1)), current])
    setFuture([])
  }

  function undo(): void {
    const history = past()
    const previous = history.at(-1)
    if (!previous) return
    const current = snapshot()
    setPast(history.slice(0, -1))
    setFuture((f) => [...f, current])
    setProject('video', previous.video)
    setProject('audio', previous.audio)
    setSelected(null)
  }

  function redo(): void {
    const history = future()
    const next = history.at(-1)
    if (!next) return
    const current = snapshot()
    setFuture(history.slice(0, -1))
    setPast((p) => [...p, current])
    setProject('video', next.video)
    setProject('audio', next.audio)
  }

  const canUndo = () => past().length > 0
  const canRedo = () => future().length > 0

  // --- assets -------------------------------------------------------------

  async function addFiles(files: File[]): Promise<void> {
    setLoading(true)
    for (const file of files) {
      try {
        const entry = await library.add(file)
        if (entry.error) {
          notify('error', `${file.name}: ${entry.error}`)
          continue
        }
        setProject('assets', entry.asset.id, entry.asset)
        notify('info', `Added ${file.name} — ${entry.asset.width}×${entry.asset.height}`)
        log.info('asset ready', { id: entry.asset.id, name: entry.asset.name })
      } catch (err) {
        notify('error', err instanceof Error ? err.message : String(err))
      }
    }
    setLoading(false)
  }

  /**
   * Put a file on the timeline.
   *
   * A file with picture and sound becomes a *linked pair* — two clips, one
   * shared `linkId` — so splitting cuts both. An audio-only file gets one
   * unlinked audio clip; a silent file gets one unlinked video clip.
   */
  function addAssetToTimeline(assetId: AssetId): void {
    const asset = project.assets[assetId]
    if (!asset) return
    commit()
    const next = appendAsset(unwrap(project), assetId, asset)
    setProject('video', next.video)
    setProject('audio', next.audio)
    setSelected(next.video.at(-1)?.id ?? next.audio.at(-1)?.id ?? null)

    const parts = [
      next.video.length ? `${next.video.length} video` : null,
      next.audio.length ? `${next.audio.length} audio` : null,
    ].filter(Boolean)
    notify('info', `Added ${asset.name} — ${parts.join(' and ')}`)
  }

  const assetIds = (): AssetId[] => Object.keys(project.assets)
  const entryFor = (assetId: AssetId): LibraryEntry | undefined => library.get(assetId)
  const getAsset = (assetId: AssetId) => project.assets[assetId]

  /**
   * Peaks for an asset's audio, computed once.
   *
   * Reuses the buffer the audio engine already decoded, so the waveform costs
   * one pass over samples and nothing more.
   */
  async function peaksFor(assetId: AssetId): Promise<Peak[] | undefined> {
    if (peaksBy[assetId]) return peaksBy[assetId]
    const entry = library.get(assetId)
    if (!entry?.audioTrack) return undefined
    try {
      const buffer = await audio.decodedAudio(assetId)
      if (!buffer) return undefined
      const peaks = computePeaks(buffer)
      setPeaksBy(assetId, peaks)
      log.debug(`peaks: ${peaks.length} buckets for ${entry.asset.name}`)
      return peaks
    } catch (err) {
      log.warn(`peaks failed for ${entry.asset.name}`, String(err))
      return undefined
    }
  }

  // --- clips --------------------------------------------------------------

  function addClip(assetId: AssetId): void {
    addAssetToTimeline(assetId)
  }

  /**
   * Split at a timeline position.
   *
   * With a clip selected, that clip splits — and its linked partner too. With
   * nothing selected, whatever is under the playhead in each lane splits.
   */
  function splitAt(time: number, lane?: Lane): void {
    commit()

    if (lane) {
      const loc = clipAtLane(laneOf(project, lane), time)
      if (!loc) return
      setProject(replace(splitLinked(unwrap(project), lane, loc.index, time)))
      return
    }

    const selectedClip = selected()
    if (selectedClip) {
      const found = findClip(project, selectedClip)
      if (found) {
        setProject(replace(splitLinked(unwrap(project), found.lane, found.index, time)))
        return
      }
    }

    // Nothing selected: split each lane independently at the playhead.
    let next = unwrap(project)
    for (const l of ['video', 'audio'] as const) {
      const loc = clipAtLane(next[l], time)
      if (loc) next = splitLinked(next, l, loc.index, time)
    }
    setProject(replace(next))
  }

  /** Delete the selected clip, and only that clip. That is the point of lanes. */
  function deleteSelected(): void {
    const id = selected()
    if (!id) return
    const found = findClip(project, id)
    if (!found) return
    commit()
    setProject(replace(removeClip(unwrap(project), found.lane, found.index)))
    setSelected(null)
  }

  function reorder(lane: Lane, from: number, to: number): void {
    if (from === to) return
    commit()
    setProject(replace(moveClip(unwrap(project), lane, from, to)))
  }

  function trim(lane: Lane, index: number, inPoint: number, outPoint: number): void {
    setProject(replace(applyTrim(unwrap(project), lane, index, inPoint, outPoint)))
  }

  function setTransform(clipId: ClipId, transform: Clip['transform']): void {
    setProject(replace(applyTransform(unwrap(project), clipId, transform!)))
  }

  function setClipGain(clipId: ClipId, gain: number): void {
    setProject(replace(applyGain(unwrap(project), clipId, gain)))
    const found = findClip(project, clipId)
    if (found) audio.setClipGain(found.clip)
  }

  function toggleMute(clipId: ClipId): void {
    setProject(replace(applyMute(unwrap(project), clipId)))
    const found = findClip(project, clipId)
    if (found) audio.setClipGain(found.clip)
  }

  /** Break the link on a selected clip, so its pair becomes independent. */
  function breakSelectedLink(): void {
    const id = selected()
    if (!id) return
    const found = findClip(project, id)
    if (!found?.clip.linkId) return
    commit()
    setProject(replace(breakLink(unwrap(project), found.clip)))
    notify('info', 'Link broken — this clip and its pair are now independent.')
  }

  // --- transport ----------------------------------------------------------

  const duration = (): number => projectDuration(project)
  const outputFps = (): number => 30
  const selectedClip = (): Clip | null => {
    const id = selected()
    return id ? (findClip(project, id)?.clip ?? null) : null
  }
  const selectedIsLinked = (): boolean => {
    const clip = selectedClip()
    return clip ? isLinked(project, clip) : false
  }
  const selectedPartner = (): Clip | null => {
    const clip = selectedClip()
    return clip ? linkedPartner(project, clip) : null
  }

  let wallClockAnchor: { at: number; from: number; runStart: number | null } | null = null

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
      const hasFiles = assetIds().length > 0
      notify('warn', hasFiles ? 'Add a clip to the timeline first — click a file under Media.' : 'Drop a video file to get started.')
      return
    }

    if (playing()) {
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
    const audioTime = audio.now()
    if (audioTime !== null) {
      setPlayhead(Math.max(0, Math.min(audioTime, duration())))
      return
    }
    if (wallClockAnchor) {
      setPlayhead(Math.min(wallClockAnchor.from + (performance.now() - wallClockAnchor.at) / 1000, duration()))
    }
  }

  function step(frames: number): void {
    seek(playhead() + frames / outputFps())
  }

  // --- layout helpers -----------------------------------------------------

  function clipRect(lane: Lane, index: number): { left: number; width: number } {
    const clips = laneOf(project, lane)
    return { left: clipStart(clips, index) * zoom(), width: clipDuration(clips[index]!) * zoom() }
  }

  const timeToX = (time: number) => time * zoom()
  const xToTime = (x: number) => x / zoom()
  const laneLength = (lane: Lane) => laneDuration(laneOf(project, lane))

  /** Keep `setProject(next)` readable at every call site. */
  function replace(next: Project): { video: Clip[]; audio: Clip[] } {
    return { video: next.video, audio: next.audio }
  }

  return {
    project,
    playhead,
    playing,
    selected,
    zoom,
    notices,
    loading,
    peaksBy,
    canUndo,
    canRedo,
    setPlayhead,
    setPlaying,
    setSelected,
    setZoom: setZoomLevel,
    // non-reactive
    library,
    frameCache,
    audio,
    getAssetAudio: (id: string) => audio.decodedAudio(id),
    // actions
    addFiles,
    addAssetToTimeline,
    addClip,
    assetIds,
    entryFor,
    getAsset,
    peaksFor,
    splitAt,
    deleteSelected,
    reorder,
    trim,
    setTransform,
    setClipGain,
    toggleMute,
    breakSelectedLink,
    seek,
    togglePlay,
    advanceClock,
    step,
    undo,
    redo,
    notify,
    // derived
    duration,
    outputFps,
    selectedClip,
    selectedIsLinked,
    selectedPartner,
    clipRect,
    laneLength,
    timeToX,
    xToTime,
    newId,
    batch,
  }
}

export type AppState = ReturnType<typeof createAppState>
