/**
 * Preview diagnostics.
 *
 * `import type` is erased at compile time, so depending on the store's type
 * costs nothing at runtime and creates no import cycle. Taking the whole store
 * beats passing twenty individual values: the caller supplies six accessors
 * (the things only the component knows) instead of assembling a data bag that
 * is mostly a copy of the store.
 *
 * The health log and the on-canvas overlay are how you tell "the video is
 * black" apart from "the canvas has collapsed to nothing" apart from "the
 * decoder never ran". That distinction is the whole reason this exists, and it
 * is why it must not be deleted when the preview looks fine on your machine.
 *
 * It lives outside the view because none of the *interesting* part needs a
 * canvas: the luma sampler takes pixel bytes, and every readout is a pure
 * function of a plain facts object. The component keeps only the two lines that
 * genuinely need a DOM — reading `getImageData`, and filling text.
 *
 * The facts are a data bag, not a live interface. No getters, no behaviour, so
 * a test can hand one over and check the wording.
 */

/** Sampled brightness of a frame. 0/0 means nothing was drawn at all. */
export interface Luma {
  max: number
  mean: number
}

// A type-only import, erased by the compiler — see the note at the top.
import type { AppState } from '../app/store/state.js'
import { clipAtLane, sourceTimeAt } from '../model/project.js'

/** The handful of things only the preview component knows. */
export interface PreviewRuntime {
  ctx: () => CanvasRenderingContext2D
  size: () => { width: number; height: number }
  counters: () => { paints: number; blackFrames: number; luma: Luma }
  lastError: () => string | null
  inFlight: () => boolean
  overlayOn: () => boolean
}

export interface PreviewFacts {
  timeline: {
    playhead: number
    videoCount: number
    audioCount: number
    duration: number
    /** Decoded frames currently held by the cache. */
    cachedFrames: number
  }
  counters: {
    paints: number
    blackFrames: number
    luma: Luma
  }
  /** The canvas as the browser has actually laid it out. */
  layout: {
    width: number
    height: number
    left: number
    top: number
    display: string
    visibility: string
    opacity: string
  }
  /** What is under the playhead, or null in a gap / on an empty timeline. */
  clip: null | {
    index: number
    in: number
    out: number
    sourceTime: number
    assetName: string
    assetWidth: number
    assetHeight: number
    assetCodec: string | null
  }
  runtime: {
    inFlight: boolean
    overlayOn: boolean
    lastError: string | null
  }
  /** `audio.describe()`, already serialised by the caller. */
  audio: unknown
  /** The output size the renderer is drawing at. */
  viewport: { width: number; height: number }
  decoder: { ready: boolean; error: string | null | undefined }
  /** Size of the frame in the cache for this time, if one is there. */
  cached: { width: number; height: number } | null
}

/**
 * Brightness of an RGBA buffer, sampled on a sparse grid.
 *
 * A full `getImageData` of a 1280x720 canvas is 3.7 MB. Sixty times a second
 * that is not a diagnostic, it is a denial of service — so sample every 64th
 * pixel, which is a few hundred reads and enough to tell "black" from "not
 * black".
 *
 * `step` is in pixels, and the byte stride is derived from it.
 */
export function sampleLuma(data: Uint8ClampedArray, step = 64): Luma {
  const stride = 4 * step
  let max = 0
  let sum = 0
  let n = 0
  for (let i = 0; i < data.length; i += stride) {
    const luma = (data[i]! + data[i + 1]! + data[i + 2]!) / 3
    if (luma > max) max = luma
    sum += luma
    n += 1
  }
  return { max: Math.round(max), mean: n ? Math.round(sum / n) : 0 }
}

/**
 * One line, logged on a timer so it stays readable.
 *
 * Layout is included because drawing perfect frames to a canvas that has
 * collapsed to 0x0 is indistinguishable from a black video — and "the video is
 * black" is a conclusion you should never have to infer from silence.
 */
export function healthLine(f: PreviewFacts): string {
  return (
    `health: ${f.counters.paints} paints, ${f.counters.blackFrames} fully black, ` +
    `last luma max=${f.counters.luma.max} mean=${f.counters.luma.mean}, ` +
    `cache=${f.timeline.cachedFrames} frames`
  )
}

export function audioLine(f: PreviewFacts): string {
  return `audio: ${JSON.stringify(f.audio)}`
}

export function layoutLine(f: PreviewFacts): string {
  const { width, height, left, top, display, visibility, opacity } = f.layout
  return (
    `layout: canvas on-screen ${Math.round(width)}x${Math.round(height)} at ` +
    `${Math.round(left)},${Math.round(top)}  display=${display} ` +
    `visibility=${visibility} opacity=${opacity}`
  )
}

/** Non-null when the canvas has no size on screen and nothing can be visible. */
export function layoutFault(f: PreviewFacts): string | null {
  if (f.layout.width < 2 || f.layout.height < 2) {
    return 'LAYOUT: the canvas has no size on screen — nothing can be visible, however correct the pixels are'
  }
  return null
}

/**
 * The on-canvas readout, drawn so it needs no devtools.
 *
 * Drawn when the preview believes it painted and did not, or on demand with `D`.
 */
export function overlayLines(f: PreviewFacts): string[] {
  const clip = f.clip
  return [
    `t=${f.timeline.playhead.toFixed(2)}   clip=${clip ? clip.index : 'none'}   ` +
      `${f.runtime.inFlight ? 'decoding…' : 'idle'}   ` +
      `${f.runtime.overlayOn ? '[D] overlay on' : '[D] overlay'}`,
    `asset  ${
      clip ? `${clip.assetName}  ${clip.assetWidth}x${clip.assetHeight} ${clip.assetCodec}` : 'none'
    }`,
    `clip   in=${clip ? clip.in.toFixed(2) : '—'}s out=${clip ? clip.out.toFixed(2) : '—'}s  ` +
      `(source t=${clip ? clip.sourceTime.toFixed(2) : '—'}s)`,
    `decoder ${f.decoder.ready ? 'ready' : 'MISSING'}${f.decoder.error ? ` — ${f.decoder.error}` : ''}`,
    `canvas  ${f.cached ? `${f.cached.width}x${f.cached.height}` : 'nothing cached yet'}`,
    `viewport ${f.viewport.width}x${f.viewport.height}`,
    `pixels  max=${f.counters.luma.max} mean=${f.counters.luma.mean} (0 = nothing was drawn)`,
    f.runtime.lastError ? `PROBLEM  ${f.runtime.lastError}` : 'ok',
  ]
}

/** How often the health line is logged. */
export const HEALTH_INTERVAL_MS = 5000

/**
 * The diagnostics, bound to one store and one component.
 *
 * Owns gathering the facts, so the component only supplies its six locals and
 * never copies the store field by field.
 */
export function createDiagnostics(state: AppState, rt: PreviewRuntime) {
  function facts(): PreviewFacts {
    const t = state.playhead()
    const loc = clipAtLane(state.project.video, t)
    const clip = loc?.clip
    const asset = clip ? state.getAsset(clip.assetId) : undefined
    const entry = clip ? state.library.get(clip.assetId) : undefined
    const cached = loc && entry?.videoSink ? state.frameCache.find(sourceTimeAt(loc, t)) : undefined
    const rect = rt.ctx().canvas.getBoundingClientRect()
    const style = getComputedStyle(rt.ctx().canvas)
    const view = rt.size()

    return {
      timeline: {
        playhead: t,
        videoCount: state.project.video.length,
        audioCount: state.project.audio.length,
        duration: state.duration(),
        cachedFrames: state.frameCache.size,
      },
      counters: rt.counters(),
      layout: {
        width: rect.width,
        height: rect.height,
        left: rect.left,
        top: rect.top,
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
      },
      clip: clip && asset
        ? {
            index: loc!.index,
            in: clip.in,
            out: clip.out,
            sourceTime: sourceTimeAt(loc!, t),
            assetName: asset.name,
            assetWidth: asset.width,
            assetHeight: asset.height,
            assetCodec: asset.videoCodec,
          }
        : null,
      runtime: {
        inFlight: rt.inFlight(),
        overlayOn: rt.overlayOn(),
        lastError: rt.lastError(),
      },
      audio: state.audio.describe(),
      viewport: view,
      decoder: { ready: !!entry?.videoSink, error: entry?.error },
      cached: cached ? { width: cached.canvas.width, height: cached.canvas.height } : null,
    }
  }

  /** The one part that needs pixels rather than facts. */
  function sample(w: number, h: number): Luma {
    try {
      return sampleLuma(rt.ctx().getImageData(0, 0, w, h).data)
    } catch {
      // -1, not 0: "could not read" must not look like "drew nothing".
      return { max: -1, mean: -1 }
    }
  }

  /** One health line per concern, plus a fault line if the canvas has no size. */
  function health(): { info: string[]; errors: string[] } {
    const f = facts()
    const fault = layoutFault(f)
    return { info: [healthLine(f), audioLine(f), layoutLine(f)], errors: fault ? [fault] : [] }
  }

  /** Fill the canvas with the readout. The only drawing the diagnostics do. */
  function drawOverlay(): string[] {
    const lines = overlayLines(facts())
    const ctx = rt.ctx()
    const view = rt.size()
    ctx.save()
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, view.width, view.height)
    ctx.fillStyle = '#8ab4ff'
    ctx.font = '16px ui-monospace, monospace'
    ctx.textBaseline = 'top'
    lines.forEach((line, i) => ctx.fillText(line, 16, 16 + i * 22))
    ctx.restore()
    return lines
  }

  return { facts, sample, health, drawOverlay }
}
