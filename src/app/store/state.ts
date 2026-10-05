/**
 * The application store: one place that owns everything.
 *
 * This file is a **composition root**, not a container of logic. It builds the
 * slices, wires their dependencies in the only order that works, and presents
 * one flat object to the UI.
 *
 * Why a flat object rather than nested slices: a component that wants to change
 * one pixel of a clip should not have to reach through `state.edits.setTransform`
 * while `state.selection` sits somewhere else. The slices are an
 * implementation detail, and this is the seam that keeps them one.
 *
 * Why slices at all: each owns its own signals and takes only what it needs, so
 * `selection.ts` and `history.ts` are testable in Node with no browser, no
 * media library and no audio context.
 *
 * Construction order is load-bearing — a slice's dependencies must already
 * exist — and is commented at each step.
 */

import { batch, createSignal } from 'solid-js'
import { createStore, produce, reconcile } from 'solid-js/store'

import { applyTracks, type Tracks } from '../../model/project-store.js'
import {
  clipStarts,
  emptyProject,
  newId,
  trackById,
  trackDuration,
  type Asset,
  type AssetId,
  type Clip,
  type Track,
  type TrackId,
  type TrackType,
  type Project,
} from '../../model/project.js'

import { AudioEngine } from '../../audio/audio-engine.js'
import { FrameCache } from '../../media/frame-cache.js'
import { MediaLibrary } from '../../media/library.js'
import { log } from '../../dev/debug.js'

import { createAssets } from './assets.js'
import { createEdits } from './edits.js'
import { createHistory } from './history.js'
import { createProjectStore } from './project-store.js'
import { createSelection } from './selection.js'
import { createTransport } from './transport.js'
import { clampZoom, ZOOM_DEFAULT } from './zoom.js'

export interface Notice {
  kind: 'info' | 'warn' | 'error'
  text: string
  id: number
}

export function createAppState() {
  const library = new MediaLibrary()
  const [project, applyProject] = createStore<Project>(emptyProject())
  const [zoom, setZoomLevel] = createSignal(ZOOM_DEFAULT)
  const [notices, setNotices] = createSignal<Notice[]>([])

  const [assetsRevision, setAssetsRevision] = createSignal(0)
  const [clipSnap, setClipSnap] = createSignal(true)
  const [laneSnap, setLaneSnap] = createSignal(true)
  const [playheadSnap, setPlayheadSnap] = createSignal(true)
  const snapping = (): boolean => clipSnap() || laneSnap()

  let noticeId = 0
  function notify(kind: Notice['kind'], text: string): void {
    const notice: Notice = { kind, text, id: ++noticeId }
    setNotices((prev) => [...prev.slice(-4), notice])
    if (kind !== 'error') {
      setTimeout(() => {
        setNotices((prev) => prev.filter((n) => n.id !== notice.id))
      }, 6000)
    }
  }

  const sel = createSelection(project)

  const frameCache = new FrameCache()
  const audio = new AudioEngine({ library, onError: (message) => notify('error', message) })

  function setProject(tracks: Tracks): void
  function setProject(trackId: TrackId, clips: Clip[]): void
  function setProject(key: 'assets', assetId: string, asset: Asset): void
  function setProject(a: unknown, b?: unknown, c?: unknown): void {
    if (a === 'assets') applyProject(a as 'assets', b as string, c as Asset)
    else if (typeof a === 'string') {
      const trackId = a as TrackId
      applyProject('tracks', (prev: Project['tracks']) =>
        prev.map((t) => (t.id === trackId ? { ...t, clips: b as Clip[] } : t)),
      )
    } else applyTracks((tracks) => applyProject('tracks', tracks), a as Tracks, sel.prune)
    projects.markDirty()
    transport.clampPlayhead()
  }

  const setTracks = (tracks: Project['tracks']): void => setProject(tracks)

  function releaseLibrary(): void {
    library.clear()
  }

  function replaceProject(next: Project): void {
    applyProject('version', next.version)
    applyProject('assets', reconcile(next.assets))
    applyProject('tracks', next.tracks)
    if (next.captions === undefined) applyProject('captions', () => undefined)
    else applyProject('captions', next.captions)
    setAssetsRevision((n) => n + 1)
    transport.clampPlayhead()
  }

  const history = createHistory(
    project,
    (tracks) => setTracks(tracks),
    () => sel.clear(),
  )

  // Tracks are structure, not clip edits, but they change through the same
  // `setTracks` seam so undo, dirty-marking and the playhead clamp all apply.
  // Video tracks stay grouped above audio ones: a new video track joins the top
  // of that group (the next layer of picture), an audio track goes underneath.
  function addTrack(type: TrackType): void {
    history.commit()
    const track: Track = { id: newId(type), type, clips: [] }
    const tracks = [...project.tracks]
    if (type === 'video') {
      let insertAt = 0
      for (let i = tracks.length - 1; i >= 0; i--) {
        if (tracks[i]!.type === 'video') {
          insertAt = i + 1
          break
        }
      }
      tracks.splice(insertAt, 0, track)
    } else {
      tracks.push(track)
    }
    setTracks(tracks)
  }

  /** Remove an empty track. A track with clips must be cleared first. */
  function removeTrack(trackId: TrackId): void {
    const track = project.tracks.find((t) => t.id === trackId)
    if (!track) return
    if (project.tracks.length <= 1) {
      notify('warn', 'The timeline needs at least one track')
      return
    }
    if (track.clips.length > 0) {
      notify('warn', `Clear the ${track.type} track before removing it`)
      return
    }
    history.commit()
    setTracks(project.tracks.filter((t) => t.id !== trackId))
  }

  const projects = createProjectStore({
    read: () => project,
    write: (next) => replaceProject(next),
    rehydrate: async (asset, file) => {
      try {
        const entry = await library.add(file, asset.id)
        if (entry.error) return { ok: false, reason: entry.error }
        return { ok: true, probed: entry.asset }
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) }
      }
    },
    fileFor: (assetId) => library.get(assetId)?.file ?? null,
    libraryEntries: () =>
      library.entries().map(([assetId, e]) => ({
        assetId,
        name: e.asset.name,
        size: e.asset.size,
        duration: e.asset.duration,
        quickHash: e.quickHash,
      })),
    writeAsset: (asset) => setProject('assets', asset.id, asset),
    releaseLibrary,
    restoreFile: async (file, assetId, name) => {
      const entry = await library.add(file, assetId)
      if (entry.error) {
        log.warn('persistence: a relinked file would not load', { name, reason: entry.error })
        return
      }
      setProject('assets', assetId, { ...entry.asset, name })
    },
    select: (clipIds) => sel.replaceAll(clipIds),
    seek: (time) => transport.seek(time),
    playhead: () => transport.playhead(),
    selected: () => sel.ids(),
    notify,
  })

  const assets = createAssets({
    project,
    library,
    audio,
    history,
    selection: sel,
    notify,
    setTracks,
    setAsset: (assetId, asset) => setProject('assets', assetId, asset),
    dropAsset: (assetId) => {
      applyProject('assets', produce((map: Project['assets']) => {
        delete map[assetId]
      }))
      setAssetsRevision((n) => n + 1)
    },
    pruneMedia: () => void projects.pruneUnusedMedia(),
    playhead: () => transport.playhead(),
    snapping,
    clipSnap,
    laneSnap,
    pixelsPerSecond: zoom,
    assetsRevision,
    rememberMedia: (assetId, file) => void projects.rememberMedia(assetId, file),
  })

  let transport: Transport
  const edits = createEdits({
    project,
    history,
    selection: sel,
    audio,
    notify,
    setTracks,
    playhead: () => transport.playhead(),
  })

  transport = createTransport({
    project,
    audio,
    selection: sel,
    notify,
    hasImportedFiles: () => assets.ids().length > 0,
    setTransform: edits.setTransform,
  })

  const clipStartsFor = (trackId: TrackId): number[] => clipStarts(trackById(project, trackId))

  const timeToX = (time: number) => time * zoom()
  const xToTime = (x: number) => x / zoom()
  const trackLength = (trackId: TrackId) => trackDuration(trackById(project, trackId))

  /** Clips of every video track, first track at the bottom. What preview and export paint. */
  const videoTracks = (): Clip[][] =>
    project.tracks.filter((t) => t.type === 'video').map((t) => t.clips)
  const videoClipCount = (): number =>
    project.tracks.reduce((n, t) => (t.type === 'video' ? n + t.clips.length : n), 0)
  const audioClipCount = (): number =>
    project.tracks.reduce((n, t) => (t.type === 'audio' ? n + t.clips.length : n), 0)

  return {
    project,
    projects,

    selected: sel.primary,
    selection: sel.ids,
    primary: sel.primary,
    isSelected: sel.isSelected,
    selectionCount: sel.count,
    selectedClips: sel.clips,
    selectedTracks: sel.tracks,
    selectClip: sel.select,
    setPrimary: sel.setPrimary,
    clearSelection: sel.clear,
    selectAll: sel.selectAll,

    transport,
    history,

    zoom,
    notices,
    snapping,
    clipSnap,
    setClipSnap,
    laneSnap,
    setLaneSnap,
    playheadSnap,
    setPlayheadSnap,
    setZoom: (value: number) => setZoomLevel(clampZoom(value)),
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    undo: history.undo,
    redo: history.redo,
    commit: history.commit,

    library,
    frameCache,
    audio,
    getAssetAudio: (id: string) => audio.decodedAudio(id),

    loading: assets.loading,
    selectedAsset: assets.selectedAsset,
    setSelectedAsset: assets.setSelectedAsset,
    peaksBy: assets.peaksBy,
    addFiles: assets.addFiles,
    dropFiles: assets.dropFiles,
    removeAsset: assets.removeAsset,
    addAssetToTimeline: assets.addAssetToTimeline,
    addAssetAt: assets.addAssetAt,
    dropTimeFor: assets.dropTimeFor,
    trackAccepts: assets.trackAccepts,
    addClip: assets.addClip,
    assetIds: assets.ids,
    entryFor: (assetId: AssetId) => library.get(assetId),
    getAsset: assets.get,
    peaksFor: assets.peaksFor,

    splitAt: edits.splitAt,
    splitSelectionAtPlayhead: edits.splitSelectionAtPlayhead,
    trimSelectionToPlayhead: edits.trimSelectionToPlayhead,
    deleteSelected: edits.deleteSelected,
    trimToPlayhead: edits.trimToPlayhead,
    clearTrack: edits.clearTrack,
    addTrack,
    removeTrack,
    duplicateSelected: edits.duplicateSelected,
    reorder: edits.reorder,
    place: edits.place,
    moveSelection: edits.moveSelection,
    moveSelectionToTrack: edits.moveSelectionToTrack,
    trim: edits.trim,
    setTransform: edits.setTransform,
    setClipGain: edits.setClipGain,
    toggleMuteSelected: edits.toggleMuteSelected,
    toggleMute: edits.toggleMute,
    toggleHideSelected: edits.toggleHideSelected,
    toggleHiddenSelected: edits.toggleHiddenSelected,
    toggleHidden: edits.toggleHidden,
    breakSelectedLinks: edits.breakSelectedLinks,
    selectionHasLinks: edits.selectionHasLinks,

    playhead: transport.playhead,
    playing: transport.playing,
    seek: transport.seek,
    togglePlay: transport.togglePlay,
    setPlaying: transport.setPlaying,
    advanceClock: transport.advanceClock,
    step: transport.step,
    resetView: transport.resetView,
    setTransformActive: transport.setTransformActive,
    duration: transport.duration,
    outputFps: transport.outputFps,
    selectedClip: transport.selectedClip,
    findClipById: transport.findClipById,
    selectedIsLinked: transport.selectedIsLinked,
    selectedPartner: transport.selectedPartner,

    notify,

    clipStartsFor,
    trackById,
    trackLength,
    videoTracks,
    videoClipCount,
    audioClipCount,
    timeToX,
    xToTime,
    newId,
    batch,
  }
}

type Transport = ReturnType<typeof createTransport>

export type { SelectMode } from './selection.js'

export type AppState = ReturnType<typeof createAppState>
