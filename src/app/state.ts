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
import { createStore } from 'solid-js/store'

import { applyLanes, type Lanes } from '../model/project-store.js'
import {
  clipDuration,
  clipStart,
  emptyProject,
  laneDuration,
  laneOf,
  newId,
  type Asset,
  type AssetId,
  type Clip,
  type Lane,
  type Project,
} from '../model/project.js'

import { AudioEngine } from '../audio/audio-engine.js'
import { FrameCache } from '../media/frame-cache.js'
import { MediaLibrary } from '../media/library.js'

import { createAssets } from './assets.js'
import { createEdits } from './edits.js'
import { createHistory } from './history.js'
import { createSelection } from './selection.js'
import { createTransport } from './transport.js'

export interface Notice {
  kind: 'info' | 'warn' | 'error'
  text: string
}

export function createAppState() {
  const library = new MediaLibrary()
  const [project, applyProject] = createStore<Project>(emptyProject())
  const [zoom, setZoomLevel] = createSignal(80) // pixels per second
  const [notices, setNotices] = createSignal<Notice[]>([])
  /** Magnetic snapping. Off means every position is exactly where you put it. */
  const [snapping, setSnapping] = createSignal(true)

  function notify(kind: Notice['kind'], text: string): void {
    setNotices((prev) => [...prev.slice(-4), { kind, text }])
    // Errors stay. A transient one is the common case and 6s is enough to read.
    if (kind !== 'error') setTimeout(() => setNotices((prev) => prev.slice(0, -1)), 6000)
  }

  /** Selection owns its own signal; nothing below may write to it directly. */
  const sel = createSelection(project)

  const frameCache = new FrameCache()
  const audio = new AudioEngine({ library, onError: (message) => notify('error', message) })

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
    // A plain two-key set, never `reconcile` — see model/project-store.ts for
    // the media library that reconcile deleted.
    else applyLanes((lanes) => applyProject(lanes), a as Lanes, sel.prune)
  }

  const setLanes = (video: Clip[], audioClips: Clip[]): void =>
    setProject({ video, audio: audioClips })

  const history = createHistory(
    project,
    // Undo/redo write lanes directly: they restore a *recorded* state, so
    // recording it as a new entry would make the stack fold in half.
    (lanes) => setLanes(lanes.video, lanes.audio),
    () => sel.clear(),
  )

  const assets = createAssets({
    project,
    library,
    audio,
    history,
    selection: sel,
    notify,
    setLanes,
    setAsset: (assetId, asset) => setProject('assets', assetId, asset),
  })

  // Declared before `edits` reads it, and only ever called once playback is
  // under way — the deferred read keeps the two slices from needing each other
  // at construction time.
  let transport: Transport
  const edits = createEdits({
    project,
    history,
    selection: sel,
    audio,
    notify,
    setLanes,
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

  // --- timeline geometry --------------------------------------------------
  // The only view maths that is neither editing nor transport.

  function clipRect(lane: Lane, index: number): { left: number; width: number } {
    const clips = laneOf(project, lane)
    return {
      left: clipStart(clips, index) * zoom(),
      width: clipDuration(clips[index]!) * zoom(),
    }
  }

  const timeToX = (time: number) => time * zoom()
  const xToTime = (x: number) => x / zoom()
  const laneLength = (lane: Lane) => laneDuration(laneOf(project, lane))

  return {
    project,

    // --- selection ---
    // `selected` is the primary clip and `selection` is the whole set. Both
    // names predate the slice and are kept so no UI file had to change.
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

    // The slices themselves, for a component that genuinely needs one whole.
    transport,
    history,

    // --- view settings ---
    zoom,
    notices,
    snapping,
    setZoom: setZoomLevel,
    setSnapping,
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    undo: history.undo,
    redo: history.redo,
    commit: history.commit,

    // --- resources (not reactive) ---
    library,
    frameCache,
    audio,
    getAssetAudio: (id: string) => audio.decodedAudio(id),

    // --- assets ---
    loading: assets.loading,
    selectedAsset: assets.selectedAsset,
    setSelectedAsset: assets.setSelectedAsset,
    peaksBy: assets.peaksBy,
    addFiles: assets.addFiles,
    removeAsset: assets.removeAsset,
    addAssetToTimeline: assets.addAssetToTimeline,
    addAssetAt: assets.addAssetAt,
    addClip: assets.addClip,
    assetIds: assets.ids,
    entryFor: (assetId: AssetId) => library.get(assetId),
    getAsset: assets.get,
    peaksFor: assets.peaksFor,

    // --- edits ---
    splitAt: edits.splitAt,
    splitSelectionAtPlayhead: edits.splitSelectionAtPlayhead,
    trimSelectionToPlayhead: edits.trimSelectionToPlayhead,
    deleteSelected: edits.deleteSelected,
    trimToPlayhead: edits.trimToPlayhead,
    clearLane: edits.clearLane,
    duplicateSelected: edits.duplicateSelected,
    reorder: edits.reorder,
    place: edits.place,
    trim: edits.trim,
    setTransform: edits.setTransform,
    setClipGain: edits.setClipGain,
    toggleMuteSelected: edits.toggleMuteSelected,
    toggleMute: edits.toggleMute,
    breakSelectedLinks: edits.breakSelectedLinks,
    selectionHasLinks: edits.selectionHasLinks,

    // --- transport ---
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

    // --- geometry ---
    clipRect,
    laneOf,
    laneLength,
    timeToX,
    xToTime,
    newId,
    batch,
  }
}

type Transport = ReturnType<typeof createTransport>

// Re-exported so the UI imports selection types from the store rather than
// reaching into a slice for one.
export type { SelectMode } from './selection.js'

export type AppState = ReturnType<typeof createAppState>
