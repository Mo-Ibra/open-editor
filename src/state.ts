/**
 * Application state and every action that can change it.
 *
 * One store, one place. Components read from it and call actions on it; they
 * never mutate the project directly. That is what makes undo a two-line
 * feature rather than a subsystem.
 */

import { batch, createSignal } from 'solid-js'
import { createStore, produce, unwrap } from 'solid-js/store'
import { MediaLibrary, type LibraryEntry } from './library.js'
import { FrameCache } from './frame-cache.js'
import {
  clipAt,
  clipDuration,
  emptyProject,
  moveClip,
  newId,
  projectDuration,
  removeClip,
  splitClip,
  type AssetId,
  type Clip,
  type ClipId,
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

  // Undo is a snapshot of the clips array. It is a few KB and it is exact,
  // which beats a command pattern for a model this small.
  const [past, setPast] = createSignal<Clip[][]>([])
  const [future, setFuture] = createSignal<Clip[][]>([])

  const frameCache = new FrameCache()

  function notify(kind: Notice['kind'], text: string): void {
    setNotices((prev) => [...prev.slice(-4), { kind, text }])
    if (kind !== 'error') setTimeout(() => setNotices((prev) => prev.slice(0, -1)), 6000)
  }

  /** Snapshot before a mutation, so undo has something to go back to. */
  function commit(): void {
    const snapshot = unwrap(project).clips.map((c) => ({ ...c }))
    setPast((prev) => [...prev.slice(-(HISTORY_LIMIT - 1)), snapshot])
    setFuture([])
  }

  function undo(): void {
    const history = past()
    const previous = history.at(-1)
    if (!previous) return
    const current = unwrap(project).clips.map((c) => ({ ...c }))
    setPast(history.slice(0, -1))
    setFuture((f) => [...f, current])
    setProject('clips', previous)
    setSelected(null)
  }

  function redo(): void {
    const history = future()
    const next = history.at(-1)
    if (!next) return
    const current = unwrap(project).clips.map((c) => ({ ...c }))
    setFuture(history.slice(0, -1))
    setPast((p) => [...p, current])
    setProject('clips', next)
  }

  const canUndo = () => past().length > 0
  const canRedo = () => future().length > 0

  // --- assets ---------------------------------------------------------------

  async function addFiles(files: File[]): Promise<void> {
    setLoading(true)
    for (const file of files) {
      try {
        const entry = await library.add(file)
        setProject('assets', entry.asset.id, entry.asset)
        if (entry.error) {
          notify('error', `${file.name}: ${entry.error}`)
        } else {
          notify('info', `Added ${file.name} — ${entry.asset.width}×${entry.asset.height}`)
        }
      } catch (err) {
        notify('error', err instanceof Error ? err.message : String(err))
      }
    }
    setLoading(false)
  }

  /**
   * The bin must iterate a REACTIVE list, or the list never updates when a
   * file lands. MediaLibrary's internal Map is not reactive, so deriving the
   * bin from it means a successful import renders nothing — the file is in
   * memory, the notice fires, and the UI stays empty.
   *
   * So: ids come from the store (reactive), the heavy entry comes from the
   * library (not reactive, and does not need to be).
   */
  const assetIds = (): AssetId[] => Object.keys(project.assets)

  const entryFor = (id: AssetId): LibraryEntry | undefined => library.get(id)

  function getAsset(id: AssetId) {
    return project.assets[id]
  }

  // --- clips ----------------------------------------------------------------

  function addClip(assetId: AssetId, atIndex?: number): void {
    const asset = project.assets[assetId]
    if (!asset) return
    commit()
    const clip: Clip = { id: newId('clp'), assetId, in: 0, out: asset.duration }
    batch(() => {
      setProject('clips', (clips) => {
        const next = clips.slice()
        next.splice(atIndex ?? next.length, 0, clip)
        return next
      })
      setSelected(clip.id)
    })
  }

  function splitAt(time: number): void {
    const loc = clipAt(project, time)
    if (!loc) return
    commit()
    setProject('clips', (clips) => splitClip(clips, loc.index, time))
  }

  function deleteSelected(): void {
    const id = selected()
    if (!id) return
    const index = project.clips.findIndex((c) => c.id === id)
    if (index < 0) return
    commit()
    batch(() => {
      setProject('clips', (clips) => removeClip(clips, index))
      setSelected(null)
    })
  }

  function reorder(from: number, to: number): void {
    if (from === to) return
    commit()
    setProject('clips', (clips) => moveClip(clips, from, to))
  }

  function trim(index: number, inPoint: number, outPoint: number): void {
    const asset = project.assets[project.clips[index]?.assetId ?? '']
    if (!asset) return
    const clampedIn = Math.max(0, Math.min(inPoint, asset.duration))
    const clampedOut = Math.max(clampedIn, Math.min(outPoint, asset.duration))
    setProject('clips', index, produce((clip) => {
      clip.in = clampedIn
      clip.out = clampedOut
    }))
  }

  function setTransform(clipId: ClipId, transform: Clip['transform']): void {
    const index = project.clips.findIndex((c) => c.id === clipId)
    if (index < 0) return
    setProject('clips', index, 'transform', transform)
  }

  // --- derived --------------------------------------------------------------

  const duration = (): number => projectDuration(project)
  const outputFps = (): number => 30
  const selectedClip = (): Clip | null => project.clips.find((c) => c.id === selected()) ?? null

  // --- transport ------------------------------------------------------------

  function seek(time: number): void {
    setPlayhead(Math.max(0, Math.min(time, duration())))
  }

  /**
   * Both transport actions refuse politely when there is nothing on the
   * timeline, and say so. A silent no-op here reads as "the keyboard is
   * broken" — which is exactly how it was reported, and it took a guess to
   * find. Silent is never the right answer to "why did nothing happen".
   */
  function requireContent(): boolean {
    if (project.clips.length > 0 && duration() > 0) return true
    const hasFiles = Object.keys(project.assets).length > 0
    notify(
      'warn',
      hasFiles
        ? 'Add a clip to the timeline first — click a file under Media.'
        : 'Drop a video file to get started.',
    )
    return false
  }

  function togglePlay(): void {
    if (!requireContent()) return
    // Playing from the very end should restart, not sit there.
    if (playhead() >= duration() - 0.01) setPlayhead(0)
    setPlaying((p) => !p)
  }

  function step(frames: number): void {
    if (!requireContent()) return
    seek(playhead() + frames / outputFps())
  }

  /** Timeline x/y for a clip, in pixels. */
  function clipRect(index: number): { left: number; width: number } {
    let start = 0
    for (let i = 0; i < index; i++) start += clipDuration(project.clips[i]!)
    return { left: start * zoom(), width: clipDuration(project.clips[index]!) * zoom() }
  }

  function timeToX(time: number): number {
    return time * zoom()
  }

  function xToTime(x: number): number {
    return x / zoom()
  }

  return {
    // reactive
    project,
    playhead,
    playing,
    selected,
    zoom,
    notices,
    loading,
    canUndo,
    canRedo,
    // setters
    setPlayhead,
    setPlaying,
    setSelected,
    setZoom: setZoomLevel,
    // non-reactive
    library,
    frameCache,
    // actions
    addFiles,
    assetIds,
    entryFor,
    getAsset,
    addClip,
    splitAt,
    deleteSelected,
    reorder,
    trim,
    setTransform,
    seek,
    togglePlay,
    step,
    undo,
    redo,
    notify,
    // derived
    duration,
    outputFps,
    selectedClip,
    clipRect,
    timeToX,
    xToTime,
  }
}

export type AppState = ReturnType<typeof createAppState>
