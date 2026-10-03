/**
 * The media library: owns every File, Input and decoder sink.
 *
 * Kept deliberately dumb. It loads and probes, hands out decoders, and
 * disposes. It has no opinion about the project model, and the project model
 * has no opinion about it — `src/project.ts` knows nothing about mediabunny.
 */

import { CanvasSink, Input, type InputAudioTrack, type InputVideoTrack, type InputFormat } from 'mediabunny'
import {
  AdtsInputFormat,
  BlobSource,
  FlacInputFormat,
  MatroskaInputFormat,
  Mp3InputFormat,
  Mp4InputFormat,
  MpegTsInputFormat,
  OggInputFormat,
  QuickTimeInputFormat,
} from 'mediabunny'
import { loadAsset } from './probe.js'
import { quickHash } from './quick-hash.js'
import type { Asset, AssetId } from '../model/project.js'
import { newId } from '../model/project.js'
import { log, tag } from '../dev/debug.js'

// MP4 and MOV share a demuxer; MKV and WebM share another.
const FORMATS: InputFormat[] = [
  new Mp4InputFormat(),
  new QuickTimeInputFormat(),
  new MatroskaInputFormat(),
  new OggInputFormat(),
  new Mp3InputFormat(),
  new FlacInputFormat(),
  new AdtsInputFormat(),
  new MpegTsInputFormat(),
]

export interface LibraryEntry {
  asset: Asset
  file: File
  /**
   * Hash of a sample of the bytes, once it has been computed. Null before then,
   * and permanently null where `crypto.subtle` is unavailable.
   *
   * Remembered because it is the only way to recognise a file that is *already*
   * on this machine as the file a project was exported with. A relink screen
   * that can only compare names is a relink screen that guesses.
   */
  quickHash: string | null
  /** Null when the browser cannot decode this file. */
  videoSink: CanvasSink | null
  videoTrack: InputVideoTrack | null
  audioTrack: InputAudioTrack | null
  /** Set when the file loaded but cannot be decoded. */
  error: string | null
}

/** Set while a frame has been requested and not yet produced. */
export type SinkState = 'idle' | 'loading' | 'ready' | 'missing'

export class MediaLibrary {
  readonly #entries = new Map<AssetId, LibraryEntry>()
  readonly #inputs = new Map<AssetId, Input>()

  get(id: AssetId): LibraryEntry | undefined {
    return this.#entries.get(id)
  }

  all(): LibraryEntry[] {
    return [...this.#entries.values()]
  }

  /**
   * Keyed pairs, for callers that need to know which asset an entry is for.
   *
   * `all()` is the wrong shape for that: `LibraryEntry` holds the asset's
   * *metadata*, and a re-probe can rewrite the name and duration, so reading the
   * id off the asset would be reading a value storage is allowed to change. The
   * key is the id.
   */
  entries(): [AssetId, LibraryEntry][] {
    return [...this.#entries.entries()]
  }

  /**
   * Register a file, optionally under a known id.
   *
   * The id matters when *reopening* a saved project: its clips reference assets
   * by id, so a fresh id would leave every clip pointing at nothing while
   * looking perfectly valid. Reusing the id is what makes a reload a reload
   * rather than a subtly broken project.
   */
  async add(file: File, id?: string): Promise<LibraryEntry> {
    const done = tag('library')
    log.info(`add ${file.name} (${(file.size / 1e6).toFixed(2)} MB)`)
    // The probe opens its own Input. Reuse that one rather than parsing the
    // container twice — on a 12 MB file that is not free.
    const loaded = await loadAsset(file, id ?? newId('ast'))
    const input = new Input({ source: new BlobSource(file), formats: FORMATS })
    const videoTrack = await input.getPrimaryVideoTrack()
    const audioTrack = await input.getPrimaryAudioTrack()

    this.#inputs.set(loaded.asset.id, input)

    const entry: LibraryEntry = {
      quickHash: await quickHash(file),
      asset: loaded.asset,
      file,
      videoSink: videoTrack && loaded.decodable ? new CanvasSink(videoTrack) : null,
      videoTrack,
      audioTrack,
      error: loaded.decodable ? null : (loaded.reason ?? 'unsupported codec'),
    }

    this.#entries.set(entry.asset.id, entry)

    log.info('probe result', {
      id: entry.asset.id,
      name: entry.asset.name,
      duration: entry.asset.duration,
      size: `${entry.asset.width}x${entry.asset.height}`,
      rotation: entry.asset.rotation,
      fps: entry.asset.frameRate,
      variableFrameRate: entry.asset.variableFrameRate,
      videoCodec: entry.asset.videoCodec,
      audioCodec: entry.asset.audioCodec,
      videoTrack: entry.videoTrack ? 'found' : 'MISSING',
      audioTrack: entry.audioTrack ? 'found' : 'none',
      decodable: entry.error === null,
      videoSink: entry.videoSink ? 'created' : 'NOT CREATED',
    })
    done()
    return entry
  }

  remove(id: AssetId): void {
    this.#inputs.get(id)?.dispose()
    this.#inputs.delete(id)
    this.#entries.delete(id)
  }

  /**
   * Drop everything, releasing the decoders.
   *
   * Separate from `dispose()` because the two mean different things: this is
   * "the project changed", and the library can be refilled a moment later.
   * `dispose()` is "the app is shutting down".
   */
  /**
   * Move an entry to a new id, in place.
   *
   * For attaching media that arrived without it: the `Input` and the sink are
   * already built around the bytes, so re-probing them would be wasted work.
   */
  rename(from: AssetId, to: AssetId): void {
    const entry = this.#entries.get(from)
    if (!entry || from === to) return
    this.#entries.set(to, { ...entry, asset: { ...entry.asset, id: to } })
    this.#entries.delete(from)
    const input = this.#inputs.get(from)
    if (input) {
      this.#inputs.set(to, input)
      this.#inputs.delete(from)
    }
  }

  clear(): void {
    for (const input of this.#inputs.values()) input.dispose()
    this.#inputs.clear()
    this.#entries.clear()
  }

  dispose(): void {
    this.clear()
  }
}
