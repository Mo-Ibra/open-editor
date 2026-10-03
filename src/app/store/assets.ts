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
  type Lane,
  type Project,
} from '../../model/project.js'
import { collectTargets, nearestTarget, targetLanes, thresholdInSeconds } from '../../model/snapping.js'
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
  dropFiles: (files: File[], lane: Lane, time: number, mode?: DropMode) => Promise<void>
  removeAsset: (assetId: AssetId) => void
  addAssetToTimeline: (assetId: AssetId) => void
  /** Add to a lane at a chosen position — used by drag-and-drop. */
  addAssetAt: (assetId: AssetId, lane: Lane, start: number, mode?: DropMode) => void
  /** Where a drop aimed at `lane` would land once snapped, for the indicator. */
  dropTimeFor: (raw: number, lane: Lane) => number
  /** Whether a file can go on a lane — drives the drop highlight. */
  laneAccepts: (assetId: AssetId, lane: Lane) => boolean
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
  /**
   * Remove an asset from the project entirely.
   *
   * Separate from dropping its clips: the bin is driven by `project.assets`, so
   * an asset whose clips are gone but whose map entry survives is still a row.
   */
  dropAsset: (assetId: AssetId) => void
  /** Reclaim the bytes of any asset no longer in the project. */
  pruneMedia: () => void
  /** Store an asset's bytes, once. Supplied by the project store. */
  rememberMedia: (assetId: AssetId, file: File) => void
  /** Read for snapping a drop: the playhead is a snap target like any other. */
  /**
   * Bumped when the whole assets map is replaced, so `ids()` — and therefore
   * the media bin's `<For>` — re-runs. Solid merges object writes in place, so
   * the map's reference does not change on its own.
   */
  assetsRevision: Accessor<number>
  playhead: () => number
  snapping: () => boolean
  /** Timeline pixels per second, so the snap threshold is a fixed *screen* distance. */
  pixelsPerSecond: () => number
  /**
   * The two independent snap toggles, so a drop can honour them the same way a
   * drag does. Without these `dropTimeFor` asked only "is either on?" and
   * collected from both lanes regardless.
   */
  clipSnap: Accessor<boolean>
  laneSnap: Accessor<boolean>
}

export function createAssets(deps: AssetDeps): AssetSlice {
  const { project, library, audio, history, selection, notify, setLanes, setAsset } = deps
  const { playhead, snapping, pixelsPerSecond, rememberMedia } = deps

  /**
   * The bin's selected file. Selecting does NOT add it to the timeline — a
   * double-click or a drag does — so a plain click is safe to make.
   */
  const [selectedAsset, setSelectedAsset] = createSignal<AssetId | null>(null)
  const [loading, setLoading] = createSignal(false)
  /** Peaks per asset, computed once and reused. The waveform redraws on every
   *  playhead move, so recomputing would make scrubbing unusable. */
  const [peaksBy, setPeaksBy] = createStore<Record<string, Peak[]>>({})
  /**
   * Peak computations in flight, keyed by asset.
   *
   * `peaksBy[assetId]` is only set once the first pass *finishes*, so without
   * this every caller arriving during a decode started its own — and
   * `computePeaks` walks the entire decoded buffer. The waveform effect asks for
   * every audio-bearing clip, so one slow decode used to turn into a burst of
   * full-buffer passes.
   *
   * Same shape as `AudioEngine.#bufferFor`, and for the same reason: the promise
   * is the cache, because the work is already in flight.
   */
  const peaksPending = new Map<string, Promise<Peak[] | undefined>>()

  /**
   * Import files, returning the ids that came out usable.
   *
   * Returning them is what lets a drop place a file it just imported — without
   * it, dropping a video from the desktop onto the timeline would import it and
   * then have nowhere to put it.
   */
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
        // The bytes go to storage now, once, and are never rewritten. A save is
        // then a few KB of JSON rather than a gigabyte of video, which is the
        // whole reason autosave is affordable.
        void rememberMedia(entry.asset.id, file)
        // Describe what the file *is*. "tone.m4a — 0x0" tells the user nothing,
        // and reads like the import failed.
        notify('info', `Added ${file.name} — ${describe(entry.asset)}`)
        log.info('asset ready', { id: entry.asset.id, name: entry.asset.name })
      } catch (err) {
        notify('error', err instanceof Error ? err.message : String(err))
      }
    }
    setLoading(false)
    return added
  }

  /**
   * Import a dropped file and put it on the timeline where it was let go.
   *
   * Dropping a file from the desktop is the most natural gesture there is, and
   * it used to import the file and leave it sitting in the bin. Doing both is
   * the obvious behaviour.
   */
  async function dropFiles(files: File[], lane: Lane, time: number, mode: DropMode = 'overwrite'): Promise<void> {
    const ids = await addFiles(files)
    if (ids.length === 0) return
    for (const id of ids) addAssetAt(id, lane, time, mode)
  }

  /** Drop a file, every clip that used it, and its bytes. */
  function removeAsset(assetId: AssetId): void {
    history.commit()
    const keep = (c: Clip) => c.assetId !== assetId
    const before = unwrap(project)
    setLanes(before.video.filter(keep), before.audio.filter(keep))
    if (selectedAsset() === assetId) setSelectedAsset(null)
    selection.clear()
    library.remove(assetId)
    // The bin lists `project.assets`, not the library, so the map entry has to
    // go too — otherwise the row stays even though its decoder is gone. And
    // then the stored bytes are pruned, or deleting and re-importing a file
    // leaks a copy every time.
    deps.dropAsset(assetId)
    deps.pruneMedia()
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
   * Drop a file onto the timeline at a position.
   *
   * This is the whole of "drag a file onto the timeline", and it is one
   * function because the interesting decisions are all about *where*, not about
   * what:
   *
   * - **Which lane?** Whatever the drop landed on, if the file can go there.
   *   Dropping an audio-only file on the video lane puts it on the audio lane
   *   rather than refusing, because the user's aim was clear and only the lane
   *   was wrong. A file with neither track is refused with a reason.
   * - **One clip or a pair?** A file with picture *and* sound becomes a linked
   *   pair, because that is what every editor does and what the user means by
   *   "add this clip". The old behaviour — keeping only the half you aimed at —
   *   quietly threw the other half away.
   * - **Overwrite or insert?** Overwrite by default, and `insert` on Shift.
   *   See `DropMode`.
   */
  function addAssetAt(assetId: AssetId, lane: Lane, start: number, mode: DropMode = 'overwrite'): void {
    const asset = project.assets[assetId]
    if (!asset) return
    if (!library.get(assetId)) return

    const canVideo = asset.hasVideo && asset.duration > 0
    const canAudio = asset.hasAudio
    if (!canVideo && !canAudio) {
      notify('warn', `${asset.name} has neither picture nor sound — there is nothing to put on the timeline.`)
      return
    }

    // Aim for the lane that was dropped on; fall back to the other if the file
    // cannot go where the pointer is.
    let target: Lane
    if (lane === 'video' && canVideo) target = 'video'
    else if (lane === 'audio' && canAudio) target = 'audio'
    else target = canVideo ? 'video' : 'audio'

    const lanes: Lane[] = canVideo && canAudio ? ['video', 'audio'] : [target]
    const time = Math.max(0, start)

    history.commit()
    const linkId = lanes.length === 2 ? newId('lnk') : undefined
    const added: ClipId[] = []
    let next = unwrap(project)

    for (const l of lanes) {
      const clip: Clip = {
        id: newId('clp'),
        lane: l,
        assetId,
        in: 0,
        out: asset.duration,
        ...(linkId ? { linkId } : {}),
      }
      next = placeClipAt(next, l, time, clip, mode)
      added.push(clip.id)
    }

    setLanes(next.video, next.audio)
    selection.replaceAll(added)
    notify(
      'info',
      `Added ${asset.name} at ${formatTime(time)}` +
        (lanes.length === 2 ? ' (linked picture and sound)' : '') +
        (mode === 'insert' ? ' — pushed the rest along' : ''),
    )
  }

  /**
   * Where a drop of `assetId` on `lane` would land, snapped.
   *
   * `lane` is not decoration. The two snap toggles mean "align to clips in this
   * row" and "align to clips in the other row", so which lanes are eligible
   * targets depends on which lane the drop is aimed at — and this used to collect
   * from **both**, unconditionally. With clip snap switched off in the toolbar, a
   * dropped file still snapped to same-lane clip edges: a toggle that was a lie
   * for drops. The policy is `targetLanes`, shared with the drag controller,
   * because the two answers have to be the same answer.
   */
  function dropTimeFor(raw: number, lane: Lane): number {
    if (!snapping()) return Math.max(0, raw)
    const targets = collectTargets(unwrap(project), {
      playhead: playhead(),
      includePlayhead: true,
      lanes: targetLanes(lane, deps.clipSnap(), deps.laneSnap()),
    })
    const threshold = thresholdInSeconds(14, pixelsPerSecond())
    const hit = nearestTarget(raw, targets, threshold)
    return hit ? hit.time : Math.max(0, raw)
  }

  /** Whether `assetId` can go on `lane` at all — drives the drop highlight. */
  function laneAccepts(assetId: AssetId, lane: Lane): boolean {
    const asset = project.assets[assetId]
    if (!asset) return false
    return lane === 'video' ? asset.hasVideo && asset.duration > 0 : asset.hasAudio
  }

  const addClip = (assetId: AssetId): void => addAssetToTimeline(assetId)

  const ids = (): AssetId[] => {
    deps.assetsRevision()
    return Object.keys(project.assets)
  }
  const get = (assetId: AssetId) => project.assets[assetId]

  /**
   * Peaks for an asset's audio, computed once.
   *
   * Reuses the buffer the audio engine already decoded, so the waveform costs
   * one pass over samples and nothing more.
   */
  async function peaksFor(assetId: AssetId): Promise<Peak[] | undefined> {
    const done = peaksBy[assetId]
    if (done) return done

    // Shared while in flight, so N callers cost one pass rather than N.
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
    // Cleared either way. Left set on success it would be a second cache with a
    // worse lifetime — and a failed pass must not be cached forever, which is the
    // same rule `AudioEngine.#bufferFor` follows.
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
    laneAccepts,
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
