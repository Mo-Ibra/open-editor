/**
 * Assets: getting files in, and getting them onto the timeline.
 *
 * Split out of `state.ts` because importing is a distinct job from editing, and
 * it is the part that touches the filesystem and the media library. Everything
 * here either owns a `File`'s lifetime or decides what clips a file becomes.
 *
 * Import deliberately does not touch the timeline. Adding a file to the project
 * and adding it to the edit are separate acts, so a stray double-click cannot
 * mutate an edit.
 */

import { createSignal, type Accessor } from 'solid-js'
import { createStore } from 'solid-js/store'
import { unwrap } from 'solid-js/store'

import { MediaLibrary } from '../../media/library.js'
import { computePeaks, type Peak } from '../../media/peaks.js'
import { AudioEngine } from '../../audio/audio-engine.js'
import { log } from '../../dev/debug.js'
import {
  appendAsset,
  newId,
  placeClip,
  type AssetId,
  type Clip,
  type Lane,
  type Project,
} from '../../model/project.js'
import type { Selection } from './selection.js'
import type { History } from './history.js'

export interface AssetSlice {
  selectedAsset: Accessor<AssetId | null>
  setSelectedAsset: (id: AssetId | null) => void
  peaksBy: Record<string, Peak[]>
  loading: Accessor<boolean>

  addFiles: (files: File[]) => Promise<void>
  removeAsset: (assetId: AssetId) => void
  addAssetToTimeline: (assetId: AssetId) => void
  /** Add to a lane at a chosen position — used by drag-and-drop. */
  addAssetAt: (assetId: AssetId, lane: Lane, start: number) => void
  addClip: (assetId: AssetId) => void

  ids: () => AssetId[]
  get: (assetId: AssetId) => Project['assets'][string] | undefined
  peaksFor: (assetId: AssetId) => Promise<Peak[] | undefined>
}

export interface AssetDeps {
  project: Project
  library: MediaLibrary
  audio: AudioEngine
  history: History
  selection: Selection
  notify: (kind: 'info' | 'warn' | 'error', text: string) => void
  /** Write both lanes. The only way the timeline changes. */
  setLanes: (video: Clip[], audio: Clip[]) => void
  setAsset: (assetId: AssetId, asset: Project['assets'][string]) => void
}

export function createAssets(deps: AssetDeps): AssetSlice {
  const { project, library, audio, history, selection, notify, setLanes, setAsset } = deps

  /**
   * The bin's selected file. Selecting does NOT add it to the timeline — a
   * double-click or a drag does — so a plain click is safe to make.
   */
  const [selectedAsset, setSelectedAsset] = createSignal<AssetId | null>(null)
  const [loading, setLoading] = createSignal(false)
  /** Peaks per asset, computed once and reused. The waveform redraws on every
   *  playhead move, so recomputing would make scrubbing unusable. */
  const [peaksBy, setPeaksBy] = createStore<Record<string, Peak[]>>({})

  async function addFiles(files: File[]): Promise<void> {
    setLoading(true)
    for (const file of files) {
      try {
        const entry = await library.add(file)
        if (entry.error) {
          notify('error', `${file.name}: ${entry.error}`)
          continue
        }
        setAsset(entry.asset.id, entry.asset)
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
    setLanes(before.video.filter(keep), before.audio.filter(keep))
    if (selectedAsset() === assetId) setSelectedAsset(null)
    selection.clear()
    library.remove(assetId)
    notify('info', 'Removed from the project. The file on disk is untouched.')
  }

  /**
   * Put a file on the timeline, at the end.
   *
   * A file with picture and sound becomes a *linked pair* — two clips sharing
   * one `linkId` — so splitting cuts both. An audio-only file gets one unlinked
   * audio clip; a silent file one unlinked video clip.
   */
  function addAssetToTimeline(assetId: AssetId): void {
    const asset = project.assets[assetId]
    if (!asset) return
    history.commit()
    const next = appendAsset(unwrap(project), assetId, asset)
    setLanes(next.video, next.audio)
    selection.replaceAll(
      next.video.length ? [next.video.at(-1)!.id] : next.audio.length ? [next.audio.at(-1)!.id] : [],
    )

    const parts = [
      next.video.length ? `${next.video.length} video` : null,
      next.audio.length ? `${next.audio.length} audio` : null,
    ].filter(Boolean)
    notify('info', `Added ${asset.name} — ${parts.join(' and ')}`)
  }

  /**
   * Add a file to one lane at a chosen timeline position.
   *
   * Used by drag-and-drop from the bin. The clip lands at `start`, so a drop
   * into empty timeline leaves a gap exactly where the user let go.
   */
  function addAssetAt(assetId: AssetId, lane: Lane, start: number): void {
    const asset = project.assets[assetId]
    if (!asset) return
    if (!library.get(assetId)) return

    history.commit()
    const wantVideo = lane === 'video' && asset.hasVideo

    if (wantVideo && !asset.hasAudio) {
      // No audio half to link, so the clip stands alone.
      const clip: Clip = { id: newId('clp'), lane: 'video', assetId, in: 0, out: asset.duration }
      setLanes([...unwrap(project).video, clip], unwrap(project).audio)
      selection.replaceAll([clip.id])
      return
    }
    if (!wantVideo && !asset.hasAudio) {
      notify('warn', `${asset.name} has no audio to add.`)
      return
    }

    let next = appendAsset(unwrap(project), assetId, asset)
    // Place each half of the pair where it was dropped, keeping only the half
    // the user aimed at when the file has both.
    for (const l of ['video', 'audio'] as const) {
      if (!next[l].length) continue
      if ((l === 'video') !== wantVideo && asset.hasVideo && asset.hasAudio) {
        next = { ...next, [l]: next[l].slice(0, -1) }
        continue
      }
      next = placeClip(next, l, next[l].length - 1, start)
    }
    setLanes(next.video, next.audio)
    selection.replaceAll(
      wantVideo
        ? next.video.length ? [next.video.at(-1)!.id] : []
        : next.audio.length ? [next.audio.at(-1)!.id] : [],
    )
    notify('info', `Added ${asset.name} at ${formatTime(start)}`)
  }

  const addClip = (assetId: AssetId): void => addAssetToTimeline(assetId)

  const ids = (): AssetId[] => Object.keys(project.assets)
  const get = (assetId: AssetId) => project.assets[assetId]

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

  return {
    selectedAsset,
    setSelectedAsset,
    peaksBy,
    loading,
    addFiles,
    removeAsset,
    addAssetToTimeline,
    addAssetAt,
    addClip,
    ids,
    get,
    peaksFor,
  }
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}
