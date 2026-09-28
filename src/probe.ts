/**
 * Probing: file -> Asset.
 *
 * This is where PLAN.md §6.3 (VFR) and §6.4 (rotation, pixel aspect ratio)
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
import type { Asset, AssetId, Rotation } from './project.js'
import { newId } from './project.js'
import { log } from './debug.js'

/** A probed file plus the live handles needed to decode it later. */
export interface LoadedAsset {
  asset: Asset
  file: File
  input: Input
  /** Null when the file has no video, or the browser cannot decode it. */
  decodable: boolean
  reason: string | null
}

export async function loadAsset(file: File, id: AssetId = newId('ast')): Promise<LoadedAsset> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS })

  if (!(await input.canRead())) {
    input.dispose()
    throw new Error(`Cannot read ${file.name} — unrecognised container`)
  }

  const video = await input.getPrimaryVideoTrack()
  const audio = await input.getPrimaryAudioTrack()

  if (!video) {
    input.dispose()
    throw new Error(`${file.name} has no video track`)
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
