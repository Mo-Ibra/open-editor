/**
 * Probing: file -> Asset.
 *
 * This is where docs/media.md
 * get solved, once, so no other module has to think about them.
 */

import {
  AdtsInputFormat,
  BlobSource,
  FlacInputFormat,
  Input,
  MatroskaInputFormat,
  Mp3InputFormat,
  Mp4InputFormat,
  MpegTsInputFormat,
  OggInputFormat,
  QuickTimeInputFormat,
  type InputFormat,
} from 'mediabunny'
import type { Asset, AssetId, Rotation } from '../model/project.js'
import { newId } from '../model/project.js'
import { log } from '../dev/debug.js'

/**
 * How long a still image occupies the timeline when it is dropped in.
 *
 * A number has to come from somewhere, and the file does not carry one. Five
 * seconds is long enough to read a title card and short enough to trim without
 * dragging; every still in the project can be retimed by dragging its clip.
 */
export const IMAGE_DURATION = 5

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp'])

/**
 * Whether a file should be treated as a still image.
 *
 * mediabunny only understands containers, so an image never reaches it. The
 * MIME type is authoritative when the browser provides one; some drag sources
 * hand over a blank type, so the extension is the fallback. SVG is deliberately
 * excluded: `createImageBitmap` cannot decode it, so it would import and then
 * never appear.
 */
export function isImageFile(file: File): boolean {
  if (file.type === 'image/svg+xml') return false
  if (file.type.startsWith('image/')) return true
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  return IMAGE_EXTENSIONS.has(ext)
}

/** A probed file plus the live handles needed to decode it later. */
export interface LoadedAsset {
  asset: Asset
  file: File
  /** Null for a still image — there is no container to read. */
  input: Input | null
  /** Null when the file has no video, or the browser cannot decode it. */
  decodable: boolean
  reason: string | null
}

export async function loadAsset(file: File, id: AssetId = newId('ast')): Promise<LoadedAsset> {
  if (isImageFile(file)) {
    // Decode once to measure it. The library decodes again on demand for the
    // frame itself; a still is cheap enough that caching the bitmap across the
    // two would save less than it costs to keep alive.
    const bitmap = await createImageBitmap(file)
    const asset: Asset = {
      id,
      name: file.name,
      duration: IMAGE_DURATION,
      width: bitmap.width,
      height: bitmap.height,
      rotation: 0,
      frameRate: 0,
      variableFrameRate: false,
      hasVideo: true,
      hasAudio: false,
      isImage: true,
      audioSampleRate: 0,
      audioChannels: 0,
      videoCodec: 'image',
      audioCodec: null,
      size: file.size,
    }
    bitmap.close()
    log.info('probed: image', { name: file.name, size: `${asset.width}x${asset.height}`, duration: asset.duration })
    return { asset, file, input: null, decodable: true, reason: null }
  }

  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })

  if (!(await input.canRead())) {
    input.dispose()
    throw new Error(`Cannot read ${file.name} — unrecognised container`)
  }

  const video = await input.getPrimaryVideoTrack()
  const audio = await input.getPrimaryAudioTrack()

  /**
   * An audio-only file is a first-class source, not a broken one.
   *
   * This used to throw "has no video track", which meant the app could not
   * import a voice memo or a music bed at all — despite the media bin accepting
   * `audio/*`, the model carrying `hasVideo: false` specifically for this case,
   * and half the timeline being an audio lane. The type had been designed for
   * it; only the loader had not.
   *
   * Nothing here is a guess: the duration comes from the container, the audio
   * figures from the track. `width`/`height` stay 0 because there is no picture
   * to measure, and a zero-sized *asset* is honest in a way that inventing a
   * frame size would not be.
   */
  if (!video) {
    if (!audio) {
      input.dispose()
      throw new Error(`${file.name} has neither picture nor sound — nothing to import`)
    }
    const audioOnly: Asset = {
      id,
      name: file.name,
      duration: await input.computeDuration(),
      width: 0,
      height: 0,
      rotation: 0,
      frameRate: 0,
      variableFrameRate: false,
      hasVideo: false,
      hasAudio: true,
      audioSampleRate: await audio.getSampleRate(),
      audioChannels: await audio.getNumberOfChannels(),
      videoCodec: null,
      audioCodec: await audio.getCodec(),
      size: file.size,
    }
    log.info('probed: audio only', { name: file.name, codec: audioOnly.audioCodec, duration: audioOnly.duration })
    return { asset: audioOnly, file, input, decodable: true, reason: null }
  }

  const duration = await input.computeDuration()
  const rotation = normalizeRotation(await video.getRotation())
  // Square-pixel dimensions already account for the display aspect ratio, so
  // anamorphic DV comes out correct without a second correction pass.
  const squareWidth = await video.getSquarePixelWidth()
  const squareHeight = await video.getSquarePixelHeight()

  // Swap for 90/270 so `width`/`height` are the on-screen dimensions.
  const swapped = rotation === 90 || rotation === 270
  const width = swapped ? squareHeight : squareWidth
  const height = swapped ? squareWidth : squareHeight

  const metrics = await video.computeFrameRateMetrics()
  const variableFrameRate =
    metrics.minFrameRate > 0 &&
    metrics.maxFrameRate > 0 &&
    metrics.maxFrameRate - metrics.minFrameRate > Math.max(0.5, metrics.bestGuessFrameRate * 0.02)

  const decodable = await video.canDecode()
  const codec = await video.getCodec()

  log.debug('raw track', {
    containerDuration: duration,
    frameRateMetrics: {
      bestGuess: metrics.bestGuessFrameRate,
      min: metrics.minFrameRate,
      max: metrics.maxFrameRate,
      average: metrics.averageFrameRate,
    },
    codedSize: `${await video.getCodedWidth()}x${await video.getCodedHeight()}`,
    squarePixelSize: `${squareWidth}x${squareHeight}`,
    canDecode: decodable,
    codec,
  })

  const asset: Asset = {
    id,
    name: file.name,
    duration,
    width: Math.round(width),
    height: Math.round(height),
    rotation,
    frameRate: metrics.bestGuessFrameRate || 30,
    variableFrameRate,
    hasVideo: true,
    hasAudio: audio !== null,
    audioSampleRate: audio ? await audio.getSampleRate() : 0,
    audioChannels: audio ? await audio.getNumberOfChannels() : 0,
    videoCodec: codec,
    audioCodec: audio ? await audio.getCodec() : null,
    size: file.size,
  }

  return {
    asset,
    file,
    input,
    decodable,
    reason: decodable
      ? null
      : `Your browser cannot decode ${codec ?? 'this codec'}. Try H.264 or VP9 in an MP4 or WebM container.`,
  }
}

// MP4 and MOV share a demuxer; MKV and WebM share another.
const ALL_FORMATS: InputFormat[] = [
  new Mp4InputFormat(),
  new QuickTimeInputFormat(),
  new MatroskaInputFormat(),
  new OggInputFormat(),
  new Mp3InputFormat(),
  new FlacInputFormat(),
  new AdtsInputFormat(),
  new MpegTsInputFormat(),
]

function normalizeRotation(r: number): Rotation {
  const n = ((Math.round(r / 90) * 90) % 360 + 360) % 360
  return (n === 90 || n === 180 || n === 270 ? n : 0) as Rotation
}
