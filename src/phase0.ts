/**
 * Phase 0 — prove the loop closes.
 *
 * No editor UI, no project model, no Solid. Just the question PLAN.md §7
 * Phase 0 asks: can a browser demux, decode, draw, encode, mux and download
 * a playable mp4 — and how fast?
 *
 * The answer to the speed question is what settles ADR-3 (re-encode-only vs
 * building a stream-copy fast path), so it gets measured, not guessed.
 */

import {
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Input,
  Output,
  AudioBufferSink,
  AudioBufferSource,
  BlobSource,
  Mp4OutputFormat,
  type InputFormat,
  WebMOutputFormat,
  type VideoCodec,
  type AudioCodec,
  AdtsInputFormat,
  FlacInputFormat,
  MatroskaInputFormat,
  Mp3InputFormat,
  Mp4InputFormat,
  MpegTsInputFormat,
  OggInputFormat,
  QuickTimeInputFormat,
} from 'mediabunny'
import { loadAsset, type LoadedAsset } from './probe.js'
import type { Asset } from './project.js'
import { chunkAudioBuffer, concatAudioBuffers, conformAudioBuffer, OUTPUT_CHANNELS, OUTPUT_SAMPLE_RATE } from './audio.js'

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

const OUT_SECONDS = 10
const CHUNK_SECONDS = 0.5

/**
 * Output settings are MUTABLE and default to the source.
 *
 * An earlier version of this harness hardcoded 1280x720, which silently
 * downscaled a 1920x1080 source and looked like the tool had degraded the
 * user's footage. That is the single most trust-destroying thing a cutter can
 * do, so: the default is the source's own resolution and frame rate, and any
 * deviation has to be something the user picked.
 */
interface OutSettings {
  width: number
  height: number
  fps: number
  bitrate: number
}

/** Rough bits-per-second-per-pixel-per-frame, tuned so 1080p30 lands ~12 Mbps. */
function bitrateFor(width: number, height: number, fps: number): number {
  return Math.round(width * height * fps * 0.11)
}

let settings: OutSettings = { width: 1920, height: 1080, fps: 30, bitrate: 12_000_000 }

function settingsForSource(asset: Asset): OutSettings {
  // VFR sources have a meaningless "average" frame rate (3.75 fps for a screen
  // recording). Emitting at that rate produces a slideshow, so target 30 and
  // hold frames. CFR sources get their own rate so no frame is dropped.
  const fps = asset.variableFrameRate ? 30 : Math.round(asset.frameRate)
  const width = asset.width
  const height = asset.height
  return { width, height, fps, bitrate: bitrateFor(width, height, fps) }
}

// --- DOM -------------------------------------------------------------------

/**
 * Element lookup that fails loudly. An unchecked cast turns a typo in an id
 * into `Cannot read properties of null` three frames later, in a function
 * unrelated to the actual mistake.
 */
const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`phase0.html is missing #${id}`)
  return el as T
}
const drop = $<HTMLDivElement>('drop')
const canvas = $<HTMLCanvasElement>('preview')
const logEl = $<HTMLPreElement>('log')
const runBtn = $<HTMLButtonElement>('run')
const dlLink = $<HTMLAnchorElement>('dl')
const playWrap = $<HTMLDivElement>('playwrap')
const playEl = $<HTMLVideoElement>('play')
const playInfo = $<HTMLPreElement>('playinfo')
const ctx = canvas.getContext('2d', { alpha: false })!

let loaded: LoadedAsset | null = null

const lines: string[] = []
function log(msg: string, cls = ''): void {
  const span = document.createElement('span')
  if (cls) span.className = cls
  span.textContent = msg + '\n'
  logEl.append(span)
  logEl.scrollTop = logEl.scrollHeight
}
function clearLog(): void {
  lines.length = 0
  logEl.textContent = ''
}

// --- Codec negotiation -----------------------------------------------------
//
// Hardcoding AAC is the single most common way a browser video tool ships
// broken. Chrome and Edge only encode AAC on macOS, iOS and Windows, via the
// platform encoder -- on Linux `AudioEncoder.isConfigSupported({ codec:
// 'mp4a.40.2' })` returns false, and the export dies with a config error even
// though every parameter is valid. Firefox has the same gap.
//
// So never assume a codec. Intersect three lists -- what the container can
// hold, what the browser can encode, and what the user actually needs -- and
// take the first combination that survives. A cutter that cannot export on a
// Linux laptop is not a cutter.

/** Ordered by preference. First viable combination wins. */
const COMBINATIONS = [
  { format: 'mp4',  video: 'avc', audio: 'aac'  },
  // NOTE: there is deliberately no `mp4 + opus` entry. Opus in MP4 muxes fine
  // and produces a file that will not play -- Firefox refuses it, QuickShot
  // refuses it. Measured, not assumed. If AAC is unavailable we switch the
  // *container*, not just the codec.
  { format: 'webm', video: 'vp9', audio: 'opus' },
  { format: 'webm', video: 'vp8', audio: 'opus' },
  { format: 'webm', video: 'vp9', audio: null   },
] as const

/** mediabunny's friendly names -> the WebCodecs codec strings. */
const WEBCODECS_VIDEO: Record<string, string> = { avc: 'avc1.42001f', hevc: 'hev1.1.6.L93.B0', vp9: 'vp09.00.10.08', vp8: 'vp8', av1: 'av01.0.04M.08' }
const WEBCODECS_AUDIO: Record<string, string> = { aac: 'mp4a.40.2', opus: 'opus', mp3: 'mp3', vorbis: 'vorbis' }

interface Plan {
  format: Mp4OutputFormat | WebMOutputFormat
  video: string
  audio: string | null
  extension: 'mp4' | 'webm'
  /** Human-readable reasons each combination was rejected. */
  notes: string[]
}

async function videoEncodable(codec: string, width: number, height: number): Promise<boolean> {
  try {
    const support = await VideoEncoder.isConfigSupported({
      codec: WEBCODECS_VIDEO[codec]!,
      width,
      height,
      bitrate: settings.bitrate,
      framerate: settings.fps,
    })
    return !!support.supported
  } catch {
    return false
  }
}

async function audioEncodable(codec: string): Promise<boolean> {
  try {
    const support = await AudioEncoder.isConfigSupported({
      codec: WEBCODECS_AUDIO[codec]!,
      sampleRate: OUTPUT_SAMPLE_RATE,
      numberOfChannels: OUTPUT_CHANNELS,
      bitrate: 128_000,
    })
    return !!support.supported
  } catch {
    return false
  }
}

async function negotiate(needsAudio: boolean): Promise<Plan | null> {
  const notes: string[] = []

  for (const combo of COMBINATIONS) {
    if (needsAudio && combo.audio === null) {
      notes.push(`${combo.format}/${combo.video} silently`)
      continue
    }

    const format =
      combo.format === 'mp4'
        ? new Mp4OutputFormat({ fastStart: 'in-memory' })
        : new WebMOutputFormat()

    // getSupportedAudioCodecs/getSupportedVideoCodecs live on the format, not
    // the Output, and they are synchronous.
    const container = format.getSupportedVideoCodecs()
    if (!container.includes(combo.video as never)) {
      notes.push(`${combo.format}/${combo.video}: container`)
      continue
    }
    if (!(await videoEncodable(combo.video, settings.width, settings.height))) {
      notes.push(`${combo.format}/${combo.video}: no encoder`)
      continue
    }

    let audio: string | null = null
    if (combo.audio !== null) {
      if (!format.getSupportedAudioCodecs().includes(combo.audio as never)) {
        notes.push(`${combo.format}/${combo.video}/${combo.audio}: container`)
        continue
      }
      if (!(await audioEncodable(combo.audio))) {
        notes.push(`${combo.format}/${combo.video}/${combo.audio}: no encoder`)
        continue
      }
      audio = combo.audio
    }

    return {
      format,
      video: combo.video,
      audio,
      extension: combo.format,
      notes,
    }
  }

  notes.push('nothing encodable')
  return null
}

// --- Playback diagnostics --------------------------------------------------
//
// "It downloaded but won't play" is the worst bug report there is, because it
// looks like success until someone tries to watch the result. So the harness
// plays its own output in a <video> and reports the browser's own error
// rather than leaving the user to guess.

const MEDIA_ERRORS: Record<number, string> = {
  1: 'MEDIA_ERR_ABORTED — the browser aborted the fetch',
  2: 'MEDIA_ERR_NETWORK — network/decode failure while fetching',
  3: 'MEDIA_ERR_DECODE — the browser could not DECODE these bytes',
  4: 'MEDIA_ERR_SRC_NOT_SUPPORTED — container or codec not supported HERE',
}

playEl.addEventListener('error', () => {
  const err = playEl.error
  const name = err ? (MEDIA_ERRORS[err.code] ?? `code ${err.code}`) : 'no error object'
  playInfo.textContent = `FAILED: ${name}\n  message: ${err?.message || '(none)'}\n  canPlayType: ${canPlay(playEl.src)}`
  log(`play    FAILED — ${name}`, 'bad')
})

playEl.addEventListener('loadedmetadata', () => {
  playInfo.textContent =
    `OK: ${playEl.videoWidth}x${playEl.videoHeight} @ ${playEl.duration.toFixed(2)}s`
  log(`play    OK — ${playEl.videoWidth}x${playEl.videoHeight}, duration ${playEl.duration.toFixed(2)}s`, 'ok')
})

function canPlay(url: string): string {
  const v = document.createElement('video')
  return v.canPlayType(url) || '"" (empty = browser will not play it)'
}

// --- Output settings UI -----------------------------------------------------

const resSel = $<HTMLSelectElement>('res')
const fpsSel = $<HTMLSelectElement>('fps')

const RES_OPTIONS: { label: string; w?: number; h?: number }[] = [
  { label: 'Match source' },
  { label: '2160p (3840x2160)', w: 3840, h: 2160 },
  { label: '1440p (2560x1440)', w: 2560, h: 1440 },
  { label: '1080p (1920x1080)', w: 1920, h: 1080 },
  { label: '720p (1280x720)', w: 1280, h: 720 },
  { label: '480p (854x480)', w: 854, h: 480 },
]

const FPS_OPTIONS = [
  { label: 'Match source' },
  { label: '24' },
  { label: '25' },
  { label: '30' },
  { label: '50' },
  { label: '60' },
]

function fillSelects(): void {
  resSel.replaceChildren(...RES_OPTIONS.map((o, i) => new Option(o.label, String(i))))
  fpsSel.replaceChildren(...FPS_OPTIONS.map((o, i) => new Option(o.label, String(i))))
  resSel.onchange = fpsSel.onchange = () => applySettings()
}

function applySettings(): void {
  if (!loaded) return
  const base = settingsForSource(loaded.asset)

  const res = RES_OPTIONS[Number(resSel.value)]!
  if (res.w && res.h) {
    // Keep the source aspect ratio. Letterboxing a 16:9 source into 4:3 would
    // be worse than the downscale it is meant to avoid.
    const scale = Math.min(res.w / base.width, res.h / base.height)
    settings.width = even(Math.round(base.width * scale))
    settings.height = even(Math.round(base.height * scale))
  } else {
    settings.width = base.width
    settings.height = base.height
  }

  const fpsOpt = FPS_OPTIONS[Number(fpsSel.value)]!
  settings.fps = fpsOpt.label === 'Match source' ? base.fps : Number(fpsOpt.label)
  settings.bitrate = bitrateFor(settings.width, settings.height, settings.fps)

  const a = loaded.asset
  const shrunk = settings.width < a.width || settings.height < a.height
  log(
    `output  ${settings.width}x${settings.height} @ ${settings.fps}  (source ${a.width}x${a.height} ` +
      `${a.variableFrameRate ? 'VFR' : a.frameRate.toFixed(2)}fps)  ${(settings.bitrate / 1e6).toFixed(1)} Mbps`,
    shrunk ? 'warn' : 'ok',
  )
  if (shrunk) log('        output is SMALLER than the source — you are downscaling', 'warn')
  if (a.variableFrameRate && settings.fps < a.frameRate) {
    log(`        output fps is below the source peak — frames WILL be dropped`, 'warn')
  }
}

/** Encoders want even dimensions; odd sizes fail isConfigSupported. */
function even(n: number): number {
  return Math.max(2, n - (n % 2))
}

// --- File input ------------------------------------------------------------

const onFile = async (file: File) => {
  clearLog()
  dlLink.hidden = true
  runBtn.disabled = true
  loaded = null

  log(`file    ${file.name}  (${(file.size / 1e6).toFixed(1)} MB)`)

  try {
    loaded = await loadAsset(file)
  } catch (err) {
    log(`probe   ${err instanceof Error ? err.message : String(err)}`, 'bad')
    return
  }

  const a = loaded.asset
  log(
    `probe   ${a.width}x${a.height}  ${a.frameRate.toFixed(2)} fps` +
      `${a.variableFrameRate ? ' (VFR)' : ' (CFR)'}  ${a.duration.toFixed(2)}s  rot ${a.rotation}`,
  )
  log(`codec   video=${a.videoCodec ?? '?'}  audio=${a.audioCodec ?? 'none'}`, 'ok')

  if (!loaded.decodable) {
    log(`decode  ${loaded.reason ?? 'unsupported'}`, 'bad')
    return
  }

  // Paint frame 0 immediately, so we know decode works before encoding does.
  const input = new Input({ source: new BlobSource(file), formats: FORMATS })
  const video = await input.getPrimaryVideoTrack()
  if (!video) {
    log('decode  no video track', 'bad')
    return
  }

  const sink = new CanvasSink(video)
  const first = await sink.getCanvas(0)
  if (!first) {
    log('decode  no frame at t=0', 'bad')
    return
  }
  drawFit(ctx, first.canvas, settings.width, settings.height)
  log('decode  frame at t=0 drawn', 'ok')

  if (typeof SharedArrayBuffer !== 'undefined') {
    log('sab     available', 'ok')
  } else {
    log('sab     MISSING — COOP/COEP headers not applied', 'warn')
  }

  input.dispose()
  settings = settingsForSource(a)
  applySettings()
  runBtn.disabled = false
}

drop.addEventListener('click', () => pickFile())
drop.addEventListener('dragover', (e) => {
  e.preventDefault()
  drop.classList.add('hot')
})
drop.addEventListener('dragleave', () => drop.classList.remove('hot'))
drop.addEventListener('drop', (e) => {
  e.preventDefault()
  drop.classList.remove('hot')
  const file = e.dataTransfer?.files[0]
  if (file) void onFile(file)
})

function pickFile(): void {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'video/*'
  input.onchange = () => {
    const file = input.files?.[0]
    if (file) void onFile(file)
  }
  input.click()
}

// --- The loop --------------------------------------------------------------

fillSelects()
runBtn.addEventListener('click', () => void run())

async function run(): Promise<void> {
  if (!loaded) return
  const { file, asset } = loaded

  runBtn.disabled = true
  dlLink.hidden = false
  dlLink.removeAttribute('href')
  dlLink.textContent = 'encoding…'
  log('')
  log('--- encoding ---')

  const totalFrames = OUT_SECONDS * settings.fps

  const input = new Input({ source: new BlobSource(file), formats: FORMATS })
  const videoTrack = await input.getPrimaryVideoTrack()
  const audioTrack = await input.getPrimaryAudioTrack()

  const plan = await negotiate(audioTrack !== null)
  if (!plan) {
    log('failed  this browser can encode neither H.264 nor VP9. Nothing to do.', 'bad')
    runBtn.disabled = false
    input.dispose()
    return
  }

  const formatLabel = `${plan.extension}/${plan.video}${plan.audio ? ` + ${plan.audio}` : ''}`
  log(`output  ${formatLabel}`, plan.video === 'avc' && plan.audio === 'aac' ? 'ok' : 'warn')
  for (const note of plan.notes) log(`        skipped ${note}`)

  const out = new Output({ format: plan.format, target: new BufferTarget() })

  canvas.width = settings.width
  canvas.height = settings.height
  const canvasSource = new CanvasSource(canvas, {
    codec: plan.video as VideoCodec,
    bitrate: settings.bitrate,
    keyFrameInterval: settings.fps * 2,
  })
  out.addVideoTrack(canvasSource)

  // --- audio ---------------------------------------------------------------
  // Two separate failure modes live here, and both are real:
  //
  //  1. Sample rate. AAC via WebCodecs takes only 44.1/48 kHz. Camera files are
  //     often 96 kHz, and the source rate straight into the encoder throws.
  //  2. No encoder at all. Chrome only encodes AAC on macOS, iOS and Windows,
  //     via the platform encoder. On Linux there is none, and the config is
  //     rejected even though every parameter is valid. Hardcoding AAC makes
  //     your export work on your Mac and fail for everyone else.
  //
  // So negotiate: intersect what the container can hold with what this browser
  // can encode, and take the first survivor.
  const audioSeconds = Math.min(OUT_SECONDS, asset.duration)
  let audioSource: AudioBufferSource | null = null
  const audioChunks: AudioBuffer[] = []

  if (audioTrack && plan.audio) {
    const codec = plan.audio
    {
      if (codec !== 'aac') {
        log(
          `audio   no AAC encoder here (macOS/Windows have one, Linux does not). Using ${codec}.`,
          'warn',
        )
      }

      const decoder = new AudioBufferSink(audioTrack)
      const decoded: AudioBuffer[] = []
      for await (const wrapped of decoder.buffers(0, audioSeconds)) decoded.push(wrapped.buffer)

      if (decoded.length) {
        const conformed = await conformAudioBuffer(concatAudioBuffers(decoded))
        audioChunks.push(...chunkAudioBuffer(conformed, CHUNK_SECONDS))
        log(
          `audio   ${decoded[0]!.sampleRate} Hz x${decoded[0]!.numberOfChannels}` +
            ` -> ${audioChunks.length} chunks @ ${conformed.sampleRate} Hz x${conformed.numberOfChannels} as ${codec}`,
          'ok',
        )
        audioSource = new AudioBufferSource({ codec: codec as AudioCodec, bitrate: 128_000 })
        out.addAudioTrack(audioSource)
      } else {
        log('audio   track present but nothing decodable in range', 'warn')
      }
    }
  }

  const videoSink = videoTrack ? new CanvasSink(videoTrack) : null
  if (videoSink) void videoSink.getCanvas(0) // prime the decoder before timing starts

  await out.start()

  const t0 = performance.now()
  let lastReport = 0
  let audioNext = 0

  // R1 mitigation #1: measure before optimising. Decode and encode are timed
  // separately because they have completely different fixes -- a decode
  // bottleneck wants parallel decode workers, an encode bottleneck wants a
  // lower resolution or a cheaper codec. Guessing here costs a week.
  let decodeMs = 0
  let encodeMs = 0
  let firstHalfMs = 0
  let secondHalfMs = 0
  let decodeMisses = 0
  let reused = 0
  const sourceGaps: number[] = []

  try {
    // CanvasSink.canvasesAtTimestamps() with monotonically increasing
    // timestamps decodes each packet AT MOST ONCE. Calling getCanvas() per
    // frame instead re-seeks and re-decodes from the last keyframe every
    // time -- which on a sparse-keyframe VFR source got progressively more
    // expensive and cost 99% of wall clock. Measured: 16.8 fps -> see R2.
    const outputTimestamps = {
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < totalFrames; i++) yield i / settings.fps
      },
    }

    let i = 0
    let lastSourceTs = -1

    for await (const wrapped of videoSink
      ? videoSink.canvasesAtTimestamps(outputTimestamps)
      : (async function* () { /* no video track: black frames */ })()) {
      const t = i / settings.fps
      const frameStart = performance.now()

      if (wrapped) {
        // A 3.75 fps source asked for 30 fps means the same source frame is
        // correct for 8 output frames in a row. Redrawing an identical canvas
        // is wasted work, so skip it. (The canvas object may differ between
        // calls, which is why this is worth measuring rather than assuming.)
        if (wrapped.timestamp === lastSourceTs) {
          reused++
        } else {
          drawFit(ctx, wrapped.canvas, settings.width, settings.height)
          if (lastSourceTs >= 0) sourceGaps.push(wrapped.timestamp - lastSourceTs)
          lastSourceTs = wrapped.timestamp
          decodeMisses++
        }
      } else {
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, settings.width, settings.height)
      }
      const frameEnd = performance.now()
      decodeMs += frameEnd - frameStart

      await canvasSource.add(t, 1 / settings.fps, { keyFrame: i % (settings.fps * 2) === 0 })
      encodeMs += performance.now() - frameEnd

      if (i < totalFrames / 2) firstHalfMs += frameEnd - frameStart
      else secondHalfMs += frameEnd - frameStart

      const wantChunk = Math.floor(t / CHUNK_SECONDS)
      while (audioSource && audioNext < audioChunks.length && audioNext <= wantChunk) {
        await audioSource.add(audioChunks[audioNext]!)
        audioNext++
      }

      if (t - lastReport >= 1) {
        const elapsed = (performance.now() - t0) / 1000
        log(`  ${String(i).padStart(4)}/${totalFrames}  ${((i + 1) / elapsed).toFixed(1)} fps  ${eta(i, totalFrames, (i + 1) / elapsed)}`)
        lastReport = t
      }
      i++
    }

    await out.finalize()
  } catch (err) {
    // A failed export must say why, not die silently in a worker.
    log(`failed  ${err instanceof Error ? err.message : String(err)}`, 'bad')
    try {
      await out.cancel()
    } catch {
      /* already torn down */
    }
    runBtn.disabled = false
    return
  } finally {
    input.dispose()
  }

  const elapsed = (performance.now() - t0) / 1000
  const buffer = (out.target as BufferTarget).buffer
  if (!buffer) {
    log('failed  muxer produced no output', 'bad')
    runBtn.disabled = false
    return
  }

  const blob = new Blob([buffer], { type: `video/${plan.extension}` })
  const url = URL.createObjectURL(blob)
  dlLink.href = url
  dlLink.download = `phase0.${plan.extension}`
  dlLink.textContent = `Download ${plan.extension} (${(blob.size / 1e6).toFixed(1)} MB)`

  // Play it here first. If the browser cannot play its own output, the file
  // is broken and no download prompt is going to change that.
  playWrap.hidden = false
  playInfo.textContent = 'checking…'
  playEl.load()
  playEl.src = url
  void playEl.play().catch((e: unknown) => {
    playInfo.textContent = `autoplay blocked (${e instanceof Error ? e.name : 'unknown'}) — press play`
  })

  const fps = totalFrames / elapsed
  const totalMs = elapsed * 1000
  const decodePct = (decodeMs / totalMs) * 100
  const realtime = fps / settings.fps
  // Frames of output for N seconds of video is N * OUT_FPS -- not N. The old
  // formula here treated one second of video as one frame and understated
  // export time by 30x.
  const slowdown = settings.fps / fps
  const exportTime = (videoSeconds: number) => videoSeconds * slowdown

  log('')
  log(`done    ${totalFrames} frames in ${elapsed.toFixed(2)}s`, 'ok')
  log(`speed   ${fps.toFixed(1)} fps at ${settings.width}x${settings.height} @ ${settings.fps}  (${realtime.toFixed(2)}x realtime)`, realtime >= 1 ? 'ok' : 'warn')
  log('')
  log('--- where the time went ---')
  log(`decode  ${(decodeMs / 1000).toFixed(2)}s  ${decodePct.toFixed(0)}%  (sink.getCanvas + draw)`, decodePct > 50 ? 'warn' : '')
  log(`encode  ${(encodeMs / 1000).toFixed(2)}s  ${(100 - decodePct).toFixed(0)}%  (canvasSource.add)`, decodePct > 50 ? '' : 'warn')
  log('')
  // Per-frame decode cost only makes sense on frames that actually decoded.
  // Reporting it across all frames just divides near-zero by a large number.
  const half = totalFrames / 2
  const firstRate = half / (firstHalfMs / 1000)
  const secondRate = half / (secondHalfMs / 1000)
  const degrading = secondRate < firstRate * 0.85
  log(
    `draws    ${reused} reused, ${decodeMisses} decoded (${((reused / totalFrames) * 100).toFixed(0)}% skipped)`,
    'ok',
  )
  log(
    `decode   ${firstRate.toFixed(0)} fps on the frames that decoded` +
      (degrading ? ' -- DEGRADING over the run' : ' -- stable'),
    degrading ? 'warn' : 'ok',
  )

  // Frame accounting. A cutter that silently drops frames is worse than one
  // that is slow, so prove it: every gap between consecutive distinct source
  // frames should be about one source frame interval. A gap far larger than
  // the median means a frame was skipped.
  if (sourceGaps.length > 1) {
    const sorted = [...sourceGaps].sort((a, b) => a - b)
    const median = sorted[sorted.length >> 1]!
    const worst = sorted[sorted.length - 1]!
    const sourceInterval = 1 / (loaded?.asset.frameRate || 30)
    log('')
    log('--- frame accounting ---')
    log(`source  ${decodeMisses} distinct frames used, ${reused} output frames held`)
    log(`interval median ${(median * 1000).toFixed(0)}ms  worst ${(worst * 1000).toFixed(0)}ms  (source ~${(sourceInterval * 1000).toFixed(0)}ms)`)
    const dropped = worst > Math.max(sourceInterval * 2.5, median * 3)
    log(
      dropped
        ? `DROPPED FRAMES — a ${(worst * 1000).toFixed(0)}ms gap is too large. This is a bug.`
        : 'no dropped frames — every gap is within one source frame interval',
      dropped ? 'bad' : 'ok',
    )
  }
  log('')
  log(`size    ${(blob.size / 1e6).toFixed(2)} MB`)
  log('')
  log(
    realtime >= 1
      ? `Verdict: ${realtime.toFixed(2)}x realtime. A 10-min edit exports in ${hms(exportTime(600))}. ADR-3 settled -- no stream-copy needed.`
      : `Verdict: ${realtime.toFixed(2)}x realtime, i.e. ${slowdown.toFixed(2)}x SLOWER than realtime. 1 min of video -> ${hms(exportTime(60))}; 10 min -> ${hms(exportTime(600))}. ADR-3 needs revisiting.`,
    realtime >= 1 ? 'ok' : 'warn',
  )
  log('')
  log(`Open the file and check: it plays, audio is in sync, duration is 10s.`)
  if (plan.extension === 'webm') log('(webm will not play in QuickShot -- use Chrome or VLC to verify)', 'warn')

  runBtn.disabled = false
}

function eta(done: number, total: number, fps: number): string {
  return `eta ${((total - done) / fps).toFixed(1)}s`
}

/** Draw a source frame into the output canvas, letterboxed to the output size. */
function drawFit(
  target: CanvasRenderingContext2D,
  source: HTMLCanvasElement | OffscreenCanvas,
  w: number,
  h: number,
): void {
  const sw = source.width
  const sh = source.height
  const scale = Math.min(w / sw, h / sh)
  const dw = sw * scale
  const dh = sh * scale

  target.fillStyle = '#000'
  target.fillRect(0, 0, w, h)
  target.drawImage(source, (w - dw) / 2, (h - dh) / 2, dw, dh)
}

function hms(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}
