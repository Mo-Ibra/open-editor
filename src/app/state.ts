/**
 * Application state and every action that can change it.
 *
 * One store, one place. Components read from it and call actions on it; they
 * never mutate the project directly. That is what makes undo a two-line
 * feature rather than a subsystem.
 */

import { batch, createSignal } from 'solid-js'
import { createStore, unwrap } from 'solid-js/store'
import { applyLanes, type Lanes } from '../model/project-store.js'
import { createHistory } from './history.js'
import { createSelection } from './selection.js'
import { FrameCache } from '../media/frame-cache.js'
import { MediaLibrary, type LibraryEntry } from '../media/library.js'
import { AudioEngine } from '../audio/audio-engine.js'
import { computePeaks, type Peak } from '../media/peaks.js'
import { log } from '../dev/debug.js'
import {
  appendAsset,
  breakLink,
  duplicateClips,
  clipAtLane,
  sourceTimeAt,
  clipDuration,
  clipStart,
  clipEnd,
  emptyProject,
  findClip,
  isLinked,
  laneDuration,
  laneOf,
  linkedPartner,
  moveClip,
  newId,
  placeClip,
  projectDuration,
  removeClip,
  setClipGain as applyGain,
  setTransform as applyTransform,
  splitLinked,
  toggleMute as applyMute,
  trimClip as applyTrim,
  type Asset,
  type AssetId,
  type Clip,
  type ClipId,
  type Lane,
  type Project,
} from '../model/project.js'

/**
 * The shortest clip a split will leave behind, in seconds.
 *
 * A split exactly on an edge would create a zero-length clip, which breaks
 * every downstream assumption about a clip having duration.
 */
const MIN_SPLIT = 0.01

export interface Notice {
  kind: 'info' | 'warn' | 'error'
  text: string
}

export function createAppState() {
  const library = new MediaLibrary()

  const [project, applyProject] = createStore<Project>(emptyProject())
  const [playhead, setPlayhead] = createSignal(0)
  const [playing, setPlaying] = createSignal(false)
  const [zoom, setZoomLevel] = createSignal(80) // pixels per second
  const [notices, setNotices] = createSignal<Notice[]>([])
  const [loading, setLoading] = createSignal(false)
  /** Magnetic snapping. Off means every position is exactly where you put it. */
  const [snapping, setSnapping] = createSignal(true)
  /** The bin's selected file. Selecting does NOT add it to the timeline any
   *  more — double-click or drag does that, so a click is safe to make. */
  const [selectedAsset, setSelectedAsset] = createSignal<AssetId | null>(null)
  /** Peaks per asset, computed once and reused. The waveform redraws on every
   *  playhead move, so recomputing would make scrubbing unusable. */
  const [peaksBy, setPeaksBy] = createStore<Record<string, Peak[]>>({})

  // --- selection ----------------------------------------------------------
  //
  // The signal lives in the slice now, so nothing below this line may
  // manipulate it directly. `sel.prune` is the one exception and it is
  // wired in as the post-write hook.

  const sel = createSelection(project)

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

  const history = createHistory(
    project,
    // Undo/redo write lanes directly: they are restoring a *recorded* state,
    // so recording it as a new entry would make the stack fold in half.
    (lanes) => {
      setProject('video', lanes.video)
      setProject('audio', lanes.audio)
    },
    () => sel.clear(),
  )

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

  /** Drop a file and every clip that used it. */
  function removeAsset(assetId: AssetId): void {
    history.commit()
    const keep = (c: Clip) => c.assetId !== assetId
    const before = unwrap(project)
    setProject('video', before.video.filter(keep))
    setProject('audio', before.audio.filter(keep))
    if (selectedAsset() === assetId) setSelectedAsset(null)
    sel.clear()
    library.remove(assetId)
    notify('info', 'Removed from the project. The file on disk is untouched.')
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
    history.commit()
    const next = appendAsset(unwrap(project), assetId, asset)
    setProject('video', next.video)
    setProject('audio', next.audio)
    sel.replaceAll(next.video.at(-1) ? [next.video.at(-1)!.id] : next.audio.length ? [next.audio.at(-1)!.id] : [])

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
   * Add a file to a lane at a chosen timeline position.
   *
   * Used by drag-and-drop from the bin. The asset becomes a linked pair when it
   * has both picture and sound, and the clip is placed at `start` so a drop into
   * empty timeline leaves a gap exactly where the user let go.
   */
  function addAssetAt(assetId: AssetId, lane: Lane, start: number): void {
    const asset = project.assets[assetId]
    if (!asset) return
    const entry = library.get(assetId)
    if (!entry) return

    history.commit()
    const wantVideo = lane === 'video' && asset.hasVideo
    if (wantVideo && !asset.hasAudio) {
      // No audio half to link, so the clip stands alone.
      const clip: Clip = { id: newId('clp'), lane: 'video', assetId, in: 0, out: asset.duration }
      setProject('video', [...unwrap(project).video, clip])
      sel.replaceAll([clip.id])
      return
    }
    if (!wantVideo && !asset.hasAudio) {
      notify('warn', `${asset.name} has no audio to add.`)
      return
    }

    let next = appendAsset(unwrap(project), assetId, asset)
    // Place each half of the pair where it was dropped.
    for (const l of ['video', 'audio'] as const) {
      const added = next[l].at(-1)
      if (!added) continue
      if ((l === 'video') !== wantVideo && asset.hasVideo && asset.hasAudio) {
        // Dropped on one lane: keep only that half.
        next = { ...next, [l]: next[l].slice(0, -1) }
        continue
      }
      const index = next[l].length - 1
      next = placeClip(next, l, index, start)
    }
    setProject('video', next.video)
    setProject('audio', next.audio)
    sel.replaceAll(wantVideo ? (next.video.at(-1) ? [next.video.at(-1)!.id] : []) : next.audio.length ? [next.audio.at(-1)!.id] : [])
    notify('info', `Added ${asset.name} at ${formatTime(start)}`)
  }

  /**
   * Split at a timeline position.
   *
   * With a clip selected, that clip splits — and its linked partner too. With
   * nothing selected, whatever is under the playhead in each lane splits.
   */
  function splitAt(time: number, lane?: Lane): void {
    history.commit()

    if (lane) {
      const loc = clipAtLane(laneOf(project, lane), time)
      if (!loc) return
      setProject(replace(splitLinked(unwrap(project), lane, loc.index, time)))
      return
    }

    const anchor = sel.primary()
    if (anchor) {
      const found = findClip(project, anchor)
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

  /**
   * Split every selected clip at the playhead.
   *
   * Two details make this more than a loop over `splitAt`:
   *
   * - A linked pair is split by `splitLinked`, which cuts *both* halves. So a
   *   selected pair must be counted once, or the second call would try to split
   *   a clip that no longer exists there.
   * - A clip whose edge is already at the playhead is skipped. Splitting there
   *   produces a zero-length clip, which is a corrupt clip, not an edit.
   *
   * Back-to-front per lane, because each split inserts a clip and shifts every
   * later index down.
   */
  function splitSelectionAtPlayhead(): void {
    const t = playhead()
    const clips = sel.clips()
    if (clips.length === 0) return

    // One entry per link group, so a selected pair splits once.
    const seen = new Set<string>()
    const targets = clips
      .filter((c) => {
        const key = c.linkId ?? c.id
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .map((c) => findClip(project, c.id)!)
      .filter(Boolean)
      .sort((a, b) => b.lane.localeCompare(a.lane) || b.index - a.index)

    let next = unwrap(project)
    let split = 0
    for (const { lane, index } of targets) {
      const laneClips = next[lane]
      const start = clipStart(laneClips, index)
      const end = clipEnd(laneClips, index)
      if (t <= start + MIN_SPLIT || t >= end - MIN_SPLIT) continue
      next = splitLinked(next, lane, index, t)
      split += 1
    }
    if (split === 0) {
      notify('info', 'Nothing to split — put the playhead inside a selected clip.')
      return
    }
    history.commit()
    setProject(replace(next))
    notify('info', `Split ${split} clip${split === 1 ? '' : 's'}.`)
  }

  /** Trim each selected clip's nearest edge to the playhead. */
  function trimSelectionToPlayhead(): void {
    const t = playhead()
    const clips = sel.clips()
    if (clips.length === 0) return

    const seen = new Set<string>()
    const targets = clips
      .filter((c) => {
        const key = c.linkId ?? c.id
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .map((c) => findClip(project, c.id)!)
      .filter(Boolean)

    const usable = targets.filter(({ lane, index }) => {
      const laneClips = laneOf(project, lane)
      return clipStart(laneClips, index) < t && t < clipEnd(laneClips, index)
    })
    if (usable.length === 0) {
      notify('info', 'Move the playhead inside a selected clip to trim it.')
      return
    }

    history.commit()
    for (const { clip, lane, index } of usable) {
      const laneClips = laneOf(project, lane)
      const loc = { clip, lane, clips: laneClips, index, start: clipStart(laneClips, index) }
      const at = sourceTimeAt(loc as never, t)
      // The nearer edge is the one the playhead is closest to.
      if (t - clipStart(laneClips, index) < clipEnd(laneClips, index) - t) {
        trim(lane, index, at, clip.out)
      } else {
        trim(lane, index, clip.in, at)
      }
    }
  }

  /**
   * Delete every selected clip.
   *
   * Only the selected clips — deleting a whole lane is a separate, deliberate
   * act. That separation is the point of having lanes: cutting the picture
   * while keeping the sound is a normal thing to want, so "delete" must never
   * quietly mean "delete the pair".
   */
  function deleteSelected(): void {
    const clips = sel.clips()
    if (clips.length === 0) return
    history.commit()
    // Highest index first per lane: removing a clip shifts every later index
    // down, so working backwards means no index is ever stale.
    const doomed = clips
      .map((clip) => findClip(project, clip.id)!)
      .filter(Boolean)
      .sort((a, b) => b.lane.localeCompare(a.lane) || b.index - a.index)
    for (const { lane, index } of doomed) {
      setProject(replace(removeClip(unwrap(project), lane, index)))
    }
    sel.clear()
    notify('info', clips.length === 1 ? 'Deleted clip.' : `Deleted ${clips.length} clips.`)
  }

  /** Trim a clip's edge to the playhead. */
  function trimToPlayhead(clipId: ClipId): void {
    const found = findClip(project, clipId)
    if (!found) return
    const loc = clipAtLane(laneOf(project, found.lane), playhead())
    if (!loc || loc.clip.id !== clipId) {
      notify('info', 'Move the playhead over the clip first.')
      return
    }
    const at = sourceTimeAt(loc, playhead())
    if (at > found.clip.out) trim(found.lane, found.index, found.clip.in, at)
    else trim(found.lane, found.index, at, found.clip.out)
  }

  /** Empty one lane, leaving the other untouched — a linked pair is broken
   *  by this, which is the honest outcome of deleting only half. */
  function clearLane(lane: Lane): void {
    if (laneOf(project, lane).length === 0) return
    history.commit()
    setProject(lane, [])
    // A selected clip on the cleared lane cannot stay selected.
    sel.replaceAll(sel.ids().filter((id) => findClip(project, id)?.lane !== lane))
    notify('info', `Cleared the ${lane} lane.`)
  }

  /**
   * Copy every selected clip, and select the copies.
   *
   * Selecting the copies rather than the originals is what makes a second
   * ctrl+D repeat the operation instead of piling up copies of the first pair.
   */
  function duplicateSelected(): void {
    const clips = sel.clips()
    if (clips.length === 0) return
    history.commit()
    const next = duplicateClips(unwrap(project), clips.map((c) => c.id))
    // The copies are the ones after each original, in the same lane order.
    const copies: ClipId[] = []
    for (const lane of ['video', 'audio'] as const) {
      const wanted = new Set(clips.filter((c) => c.lane === lane).map((c) => c.id))
      const laneClips = next[lane]
      for (let i = 0; i < laneClips.length; i += 1) {
        // A copy sits immediately after its original, so anything at an odd
        // position following a wanted clip is a copy of it.
        if (i > 0 && wanted.has(laneClips[i - 1]!.id)) copies.push(laneClips[i]!.id)
      }
    }
    setProject('video', next.video)
    setProject('audio', next.audio)
    sel.replaceAll(copies)
    notify('info', copies.length === 1 ? 'Duplicated clip.' : `Duplicated ${copies.length} clips.`)
  }

  function reorder(lane: Lane, from: number, to: number): void {
    if (from === to) return
    history.commit()
    setProject(replace(moveClip(unwrap(project), lane, from, to)))
  }

  /**
   * Move a clip so it starts at `start`, leaving a gap if it moves right.
   * Clamped so a clip can never overlap the one before it.
   */
  function place(lane: Lane, index: number, start: number): void {
    setProject(replace(placeClip(unwrap(project), lane, index, start)))
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

  /** Mute or unmute every selected audio clip, leaving video clips alone. */
  function toggleMuteSelected(): void {
    const clips = sel.clips().filter((c) => c.lane === 'audio')
    if (clips.length === 0) return
    // Mute all if any of them is currently audible, so one keypress mutes the
    // selection rather than flipping each clip independently.
    const shouldMute = clips.some((c) => !c.muted)
    for (const clip of clips) {
      if (Boolean(clip.muted) === shouldMute) continue
      setProject(replace(applyMute(unwrap(project), clip.id)))
      const found = findClip(project, clip.id)
      if (found) audio.setClipGain(found.clip)
    }
    notify('info', `${shouldMute ? 'Muted' : 'Unmuted'} ${clips.length} clip${clips.length === 1 ? '' : 's'}.`)
  }

  function toggleMute(clipId: ClipId): void {
    setProject(replace(applyMute(unwrap(project), clipId)))
    const found = findClip(project, clipId)
    if (found) audio.setClipGain(found.clip)
  }

  /**
   * Break the link on every selected linked clip, so each pair becomes
   * independent. Unlinked clips are skipped rather than being an error: a
   * mixed selection is normal once ctrl-click is in play.
   */
  function breakSelectedLinks(): void {
    const linked = sel.clips().filter((c) => c.linkId)
    if (linked.length === 0) return
    history.commit()
    for (const clip of linked) setProject(replace(breakLink(unwrap(project), clip)))
    notify('info', `Unlinked ${linked.length} clip${linked.length === 1 ? '' : 's'}.`)
  }

  const selectionHasLinks = (): boolean => sel.clips().some((c) => Boolean(c.linkId))

  // --- transport ----------------------------------------------------------

  const duration = (): number => projectDuration(project)
  const outputFps = (): number => 30
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

  function resetView(): void {
    sel.clear()
    notify('info', 'View reset.')
  }

  /** Transform the clip under the playhead, or the selection. */
  function setTransformActive(transform: Clip['transform']): void {
    const clip = selectedClip() ?? (() => {
      const loc = clipAtLane(project.video, playhead())
      return loc?.clip ?? null
    })()
    if (!clip) {
      notify('warn', 'Select a clip first.')
      return
    }
    setTransform(clip.id, transform)
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
  function replace(next: Project): Lanes {
    return { video: next.video, audio: next.audio }
  }

  /**
   * The only way the project changes.
   *
   * Wrapping the store setter is deliberate: a selection outliving the clip it
   * names is a live hazard, because every batch action resolves its targets
   * through it. One deleted clip would otherwise stay selected and silently
   * swallow the next Delete. Pruning here means no caller can forget.
   */
  function setProject(lanes: Lanes): void
  function setProject(lane: Lane, clips: Clip[]): void
  function setProject(key: 'assets', assetId: string, asset: Asset): void
  function setProject(a: unknown, b?: unknown, c?: unknown): void {
    // Asset writes cannot orphan a clip selection, so they skip the prune.
    if (a === 'assets') applyProject(a as 'assets', b as string, c as Asset)
    else if (typeof a === 'string') applyProject(a as Lane, b as Clip[])
    // A plain two-key set, never `reconcile` — see src/project-store.ts for the
    // media library that reconcile deleted.
    else applyLanes((lanes) => applyProject(lanes), a as Lanes, sel.prune)
  }

  return {
    project,
    playhead,
    playing,
    // Selection. `selected` is the primary clip and `selection` is the whole
    // set — both names predate the slice and are kept so no UI file changed.
    // Anything new should use the explicit ones below.
    selected: sel.primary,
    selection: sel.ids,
    primary: sel.primary,
    isSelected: sel.isSelected,
    selectionCount: sel.count,
    selectedClips: sel.clips,
    selectedLanes: sel.lanes,
    selectClip: sel.select,
    setPrimary: sel.setPrimary,
    clearSelection: sel.clear,
    selectAll: sel.selectAll,
    zoom,
    notices,
    loading,
    snapping,
    selectedAsset,
    peaksBy,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    undo: history.undo,
    redo: history.redo,
    commit: history.commit,
    setPlayhead,
    setPlaying,
    setZoom: setZoomLevel,
    setSnapping,
    setSelectedAsset,
    // non-reactive
    library,
    frameCache,
    audio,
    getAssetAudio: (id: string) => audio.decodedAudio(id),
    // actions
    addFiles,
    addAssetToTimeline,
    addAssetAt,
    addClip,
    assetIds,
    entryFor,
    getAsset,
    peaksFor,
    splitAt,
    deleteSelected,
    duplicateSelected,
    splitSelectionAtPlayhead,
    trimSelectionToPlayhead,
    toggleMuteSelected,
    breakSelectedLinks,
    selectionHasLinks,
    trimToPlayhead,
    clearLane,
    reorder,
    place,
    trim,
    setTransform,
    setClipGain,
    toggleMute,
    seek,
    togglePlay,
    advanceClock,
    step,
    notify,
    resetView,
    setTransformActive,
    removeAsset,
    // derived
    duration,
    outputFps,
    selectedClip,
    findClipById,
    laneOf,
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

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

// Re-exported so the UI imports selection types from the store rather than
// reaching into a slice for one.
export type { SelectMode } from './selection.js'

export type AppState = ReturnType<typeof createAppState>
