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
  placeClipAt,
  type Asset,
  type AssetId,
  type Clip,
  type ClipId,
  type DropMode,
  type TrackId,
  type Project,
} from '../../model/project.js'
import { collectTargets, nearestTarget, targetTracks, thresholdInSeconds } from '../../model/snapping.js'
import type { Selection } from './selection.js'
import type { History } from './history.js'

/** One line saying what an asset is, for the import notice and the bin. */
function describe(asset: Asset): string {
  const kind = asset.hasVideo ? `${asset.width}×${asset.height}` : 'audio only'
  const sound = asset.hasAudio
    ? asset.hasVideo
      ? `, ${asset.audioChannels}ch ${asset.audioCodec ?? 'audio'}`
      : `${asset.audioChannels}ch ${asset.audioCodec ?? 'audio'}`
    : ', no sound'
  return `${kind}${sound} · ${Math.round(asset.duration * 100) / 100}s`
}

export interface AssetSlice {
  selectedAsset: Accessor<AssetId | null>
  setSelectedAsset: (id: AssetId | null) => void
  peaksBy: Record<string, Peak[]>
  loading: Accessor<boolean>

  addFiles: (files: File[]) => Promise<AssetId[]>
  dropFiles: (files: File[], trackId: TrackId, time: number, mode?: DropMode) => Promise<void>
  removeAsset: (assetId: AssetId) => void
  addAssetToTimeline: (assetId: AssetId) => void
  addAssetAt: (assetId: AssetId, trackId: TrackId, start: number, mode?: DropMode) => void
  dropTimeFor: (raw: number, trackId: TrackId) => number
  trackAccepts: (assetId: AssetId, trackId: TrackId) => boolean
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
  setTracks: (tracks: Project['tracks']) => void
  setAsset: (assetId: AssetId, asset: Project['assets'][string]) => void
  dropAsset: (assetId: AssetId) => void
  pruneMedia: () => void
  rememberMedia: (assetId: AssetId, file: File) => void
  assetsRevision: Accessor<number>
  playhead: () => number
  snapping: () => boolean
  pixelsPerSecond: () => number
  clipSnap: Accessor<boolean>
  laneSnap: Accessor<boolean>
}

export function createAssets(deps: AssetDeps): AssetSlice {
  const { project, library, audio, history, selection, notify, setTracks, setAsset } = deps
  const { playhead, snapping, pixelsPerSecond, rememberMedia } = deps

  const [selectedAsset, setSelectedAsset] = createSignal<AssetId | null>(null)
  const [loading, setLoading] = createSignal(false)
  const [peaksBy, setPeaksBy] = createStore<Record<string, Peak[]>>({})
  const peaksPending = new Map<string, Promise<Peak[] | undefined>>()

  async function addFiles(files: File[]): Promise<AssetId[]> {
    setLoading(true)
    const added: AssetId[] = []
    for (const file of files) {
      try {
        const entry = await library.add(file)
        if (entry.error) {
          notify('error', `${file.name}: ${entry.error}`)
          continue
        }
        setAsset(entry.asset.id, entry.asset)
        added.push(entry.asset.id)
        void rememberMedia(entry.asset.id, file)
        notify('info', `Added ${file.name} — ${describe(entry.asset)}`)
        log.info('asset ready', { id: entry.asset.id, name: entry.asset.name })
      } catch (err) {
        notify('error', err instanceof Error ? err.message : String(err))
      }
    }
    setLoading(false)
    return added
  }

  async function dropFiles(files: File[], trackId: TrackId, time: number, mode: DropMode = 'overwrite'): Promise<void> {
    const ids = await addFiles(files)
    if (ids.length === 0) return
    for (const id of ids) addAssetAt(id, trackId, time, mode)
  }

  function removeAsset(assetId: AssetId): void {
    history.commit()
    const keep = (c: Clip) => c.assetId !== assetId
    const before = unwrap(project)
    setTracks(before.tracks.map((t) => ({ ...t, clips: t.clips.filter(keep) })))
    if (selectedAsset() === assetId) setSelectedAsset(null)
    selection.clear()
    library.remove(assetId)
    deps.dropAsset(assetId)
    deps.pruneMedia()
    notify('info', 'Removed from the project. The file on disk is untouched.')
  }

  function addAssetToTimeline(assetId: AssetId): void {
    const asset = project.assets[assetId]
    if (!asset) return
    history.commit()
    const next = appendAsset(unwrap(project), assetId, asset)
    setTracks(next.tracks)
    const vTrack = next.tracks.find((t) => t.type === 'video')
    const aTrack = next.tracks.find((t) => t.type === 'audio')
    selection.replaceAll(
      vTrack?.clips.length ? [vTrack.clips.at(-1)!.id] : aTrack?.clips.length ? [aTrack.clips.at(-1)!.id] : [],
    )

    const parts = [
      vTrack?.clips.length ? `${vTrack.clips.length} video` : null,
      aTrack?.clips.length ? `${aTrack.clips.length} audio` : null,
    ].filter(Boolean)
    notify('info', `Added ${asset.name} — ${parts.join(' and ')}`)
  }

  function addAssetAt(assetId: AssetId, trackId: TrackId, start: number, mode: DropMode = 'overwrite'): void {
    const asset = project.assets[assetId]
    if (!asset) return
    if (!library.get(assetId)) return

    const canVideo = asset.hasVideo && asset.duration > 0
    const canAudio = asset.hasAudio
    if (!canVideo && !canAudio) {
      notify('warn', `${asset.name} has neither picture nor sound — there is nothing to put on the timeline.`)
      return
    }

    const projectTrackIds = project.tracks.map((t) => t.id)
    let target: TrackId
    const targetType = project.tracks.find((t) => t.id === trackId)?.type
    if (targetType === 'video' && canVideo) target = trackId
    else if (targetType === 'audio' && canAudio) target = trackId
    else target = canVideo ? (projectTrackIds.find((id) => project.tracks.find((t) => t.id === id)?.type === 'video') ?? trackId) : (projectTrackIds.find((id) => project.tracks.find((t) => t.id === id)?.type === 'audio') ?? trackId)

    const targetTypes: string[] = canVideo && canAudio ? ['video', 'audio'] : [project.tracks.find((t) => t.id === target)?.type ?? 'video']
    const time = Math.max(0, start)

    history.commit()
    const linkId = targetTypes.length === 2 ? newId('lnk') : undefined
    const added: ClipId[] = []
    let next = unwrap(project)

    for (const type of targetTypes) {
      // A linked picture+sound drop belongs where the user dropped *this* half;
      // the other half goes to the first track of its kind. A bare `find` sent
      // both halves to the first track of each kind, so dropping onto a second
      // video track silently relocated the clip to the first.
      const tid = type === targetType
        ? target
        : (project.tracks.find((t) => t.type === type)?.id ?? target)
      const clip: Clip = {
        id: newId('clp'),
        trackId: tid,
        assetId,
        in: 0,
        out: asset.duration,
        ...(linkId ? { linkId } : {}),
      }
      next = placeClipAt(next, tid, time, clip, mode)
      added.push(clip.id)
    }

    setTracks(next.tracks)
    selection.replaceAll(added)
    notify(
      'info',
      `Added ${asset.name} at ${formatTime(time)}` +
        (targetTypes.length === 2 ? ' (linked picture and sound)' : '') +
        (mode === 'insert' ? ' — pushed the rest along' : ''),
    )
  }

  function dropTimeFor(raw: number, trackId: TrackId): number {
    if (!snapping()) return Math.max(0, raw)
    const allTrackIds = project.tracks.map((t) => t.id)
    const targets = collectTargets(unwrap(project), {
      playhead: playhead(),
      includePlayhead: true,
      tracks: targetTracks(trackId, allTrackIds, deps.clipSnap(), deps.laneSnap()),
    })
    const threshold = thresholdInSeconds(14, pixelsPerSecond())
    const hit = nearestTarget(raw, targets, threshold)
    return hit ? hit.time : Math.max(0, raw)
  }

  function trackAccepts(assetId: AssetId, trackId: TrackId): boolean {
    const asset = project.assets[assetId]
    if (!asset) return false
    const track = project.tracks.find((t) => t.id === trackId)
    if (!track) return false
    return track.type === 'video' ? asset.hasVideo && asset.duration > 0 : asset.hasAudio
  }

  const addClip = (assetId: AssetId): void => addAssetToTimeline(assetId)

  const ids = (): AssetId[] => {
    deps.assetsRevision()
    return Object.keys(project.assets)
  }
  const get = (assetId: AssetId) => project.assets[assetId]

  async function peaksFor(assetId: AssetId): Promise<Peak[] | undefined> {
    const done = peaksBy[assetId]
    if (done) return done

    const running = peaksPending.get(assetId)
    if (running) return running

    const entry = library.get(assetId)
    if (!entry?.audioTrack) return undefined

    const promise = (async () => {
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
    })()

    peaksPending.set(assetId, promise)
    try {
      return await promise
    } finally {
      peaksPending.delete(assetId)
    }
  }

  return {
    selectedAsset,
    setSelectedAsset,
    peaksBy,
    loading,
    addFiles,
    dropFiles,
    removeAsset,
    addAssetToTimeline,
    addAssetAt,
    dropTimeFor,
    trackAccepts,
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
