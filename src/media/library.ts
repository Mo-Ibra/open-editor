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

  async add(file: File): Promise<LibraryEntry> {
    const done = tag('library')
    log.info(`add ${file.name} (${(file.size / 1e6).toFixed(2)} MB)`)
    // The probe opens its own Input. Reuse that one rather than parsing the
    // container twice — on a 12 MB file that is not free.
    const loaded = await loadAsset(file, newId('ast'))
    const input = new Input({ source: new BlobSource(file), formats: FORMATS })
    const videoTrack = await input.getPrimaryVideoTrack()
    const audioTrack = await input.getPrimaryAudioTrack()

    this.#inputs.set(loaded.asset.id, input)

    const entry: LibraryEntry = {
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

  dispose(): void {
    for (const input of this.#inputs.values()) input.dispose()
    this.#inputs.clear()
    this.#entries.clear()
  }
}
