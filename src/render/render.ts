/**
 * The single render pass (docs/decisions/0001-one-render-function.md).
 *
 * Preview and export both call `renderFrame`. There is exactly one
 * implementation, so there is nothing that can drift between what you see and
 * what you get. The only difference between preview and export is *which
 * source frame is fetched* — never how it is drawn.
 *
 * Do not add a second drawing path. Do not add a "fast preview" renderer.
 */

export interface ClipTransform {
  scale: number
  /** Offset from centre, in output pixels. */
  x: number
  y: number
}

export interface RenderClip {
  transform?: ClipTransform
}

/**
 * How a source is scaled into the output.
 *
 * `contain` (the default) fits the whole source inside the frame, letterboxing
 * the remainder. `cover` fills the frame and crops the overflow. Stills use
 * `cover`, because a photograph that is not the sequence's aspect otherwise
 * sits as a small strip in the middle of a much larger canvas.
 */
export type RenderFit = 'contain' | 'cover'

export interface RenderOptions {
  width: number
  height: number
  background?: string
  fit?: RenderFit
}

/**
 * One text layer, already resolved to output pixels.
 *
 * Produced by `textFrameAt` in the model, which owns the animation maths, so
 * this file stays a drawing file: it measures, lays out, and paints. The
 * fields are plain numbers and strings with no model types leaking in.
 */
export interface RenderText {
  text: string
  /** Anchor, normalised to the frame. */
  x: number
  y: number
  align: 'left' | 'center' | 'right'
  font: string
  weight: number
  italic: boolean
  /** Font size in output pixels. */
  size: number
  lineHeight: number
  /** Letter spacing in output pixels. */
  tracking: number
  color: string
  background: string | null
  /** Plate padding in output pixels. */
  padding: number
  shadow: boolean
  /** Outline width in output pixels; 0 means none. */
  stroke: number
  strokeColor: string
  opacity: number
  /** Vertical offset in output pixels, from the in-animation. */
  offsetY: number
  scale: number
  /** Fraction of characters to reveal, 0..1 (typewriter). */
  reveal: number
}

/** The single place the source is scaled: contain letterboxes, cover crops. */
function frameScale(
  source: { width: number; height: number },
  options: RenderOptions,
): number {
  const horizontal = options.width / source.width
  const vertical = options.height / source.height
  return (options.fit ?? 'contain') === 'cover'
    ? Math.max(horizontal, vertical)
    : Math.min(horizontal, vertical)
}

/** A source image plus its intrinsic size. */
export interface SourceImage {
  image: CanvasImageSource
  width: number
  height: number
}

/**
 * Draw one source frame for one clip into `ctx`.
 *
 * The source is assumed already upright: rotation and pixel-aspect correction
 * are applied by the media layer when the frame is produced, so that preview
 * and export cannot disagree about them. See `src/library.ts`.
 *
 * Geometry: the source is scaled into the output — letterboxed (`contain`, the
 * default) or cropped (`cover`, for stills) — then the clip transform is
 * applied about the centre of the output. A scale above 1 therefore zooms in on
 * the centre of the frame, which is the only interpretation a user ever wants
 * from "zoom".
 */
export function renderFrame(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  source: SourceImage,
  clip: RenderClip,
  options: RenderOptions,
  texts?: readonly RenderText[],
): void {
  const { width, height, background = '#000' } = options

  ctx.save()
  ctx.fillStyle = background
  ctx.fillRect(0, 0, width, height)

  const fit = frameScale(source, options)
  const drawWidth = source.width * fit
  const drawHeight = source.height * fit

  const transform = clip.transform
  const scale = transform?.scale ?? 1

  ctx.translate(width / 2 + (transform?.x ?? 0), height / 2 + (transform?.y ?? 0))
  if (scale !== 1) ctx.scale(scale, scale)

  ctx.drawImage(source.image, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight)
  ctx.restore()

  // Text on top, in the same pass, so an exported title and a previewed one
  // are the same drawing operation rather than two that can drift (ADR-1).
  if (texts && texts.length > 0) drawTexts(ctx, texts)
}

/** Draw an empty output frame — a gap in the timeline, or a missing source. */
export function renderBlank(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  options: RenderOptions,
  texts?: readonly RenderText[],
): void {
  ctx.save()
  ctx.fillStyle = options.background ?? '#000'
  ctx.fillRect(0, 0, options.width, options.height)
  ctx.restore()
  // A title over black is exactly the closing-card case; a blank frame that
  // dropped its text would be a frame the export and the preview disagree on.
  if (texts && texts.length > 0) drawTexts(ctx, texts)
}

/** The one way a text layer is laid out, shared by drawing and hit-testing. */
interface TextLayout {
  lines: string[]
  widths: number[]
  lineHeight: number
  blockWidth: number
  blockHeight: number
  padX: number
  padY: number
}

function applyTextFont(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  layer: RenderText,
): void {
  ctx.font = `${layer.italic ? 'italic ' : ''}${layer.weight} ${layer.size}px ${layer.font}`
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  // `letterSpacing` is not in every lib.dom yet, so it is set defensively.
  if ('letterSpacing' in ctx) {
    ;(ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${layer.tracking}px`
  }
}

function layoutText(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  layer: RenderText,
): TextLayout {
  const lines = layer.text.split('\n')
  ctx.save()
  applyTextFont(ctx, layer)
  const widths = lines.map((line) => ctx.measureText(line).width)
  ctx.restore()
  const blockWidth = widths.reduce((max, w) => (w > max ? w : max), 0)
  const lineHeight = layer.size * layer.lineHeight
  const blockHeight = Math.max(lineHeight, lines.length * lineHeight)
  const pad = layer.background ? layer.padding : 0
  return { lines, widths, lineHeight, blockWidth, blockHeight, padX: pad, padY: pad * 0.5 }
}

function roundRect(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2))
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + width, y, x + width, y + height, r)
  ctx.arcTo(x + width, y + height, x, y + height, r)
  ctx.arcTo(x, y + height, x, y, r)
  ctx.arcTo(x, y, x + width, y, r)
  ctx.closePath()
}

/** Draw resolved text layers into `ctx`, on top of whatever is already there. */
export function drawTexts(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  layers: readonly RenderText[],
): void {
  const width = ctx.canvas.width
  const height = ctx.canvas.height
  for (const layer of layers) {
    if (layer.opacity <= 0.001 || layer.size <= 0) continue
    const text = layer.reveal >= 1 ? layer.text : layer.text.slice(0, Math.floor(layer.text.length * layer.reveal))
    if (text.length === 0) continue

    ctx.save()
    ctx.globalAlpha = Math.max(0, Math.min(1, layer.opacity))
    ctx.translate(layer.x * width, layer.y * height + layer.offsetY)
    if (layer.scale !== 1) ctx.scale(layer.scale, layer.scale)

    const layout = layoutText(ctx, { ...layer, text })
    if (layer.background) {
      ctx.fillStyle = layer.background
      roundRect(
        ctx,
        -layout.blockWidth / 2 - layout.padX,
        -layout.blockHeight / 2 - layout.padY,
        layout.blockWidth + layout.padX * 2,
        layout.blockHeight + layout.padY * 2,
        layer.size * 0.28,
      )
      ctx.fill()
    }

    applyTextFont(ctx, layer)
    const firstY = -((layout.lines.length - 1) * layout.lineHeight) / 2
    for (let i = 0; i < layout.lines.length; i++) {
      const line = layout.lines[i]!
      if (line.length === 0) continue
      const lineWidth = layout.widths[i]!
      const x = layer.align === 'center' ? -lineWidth / 2 : layer.align === 'right' ? -lineWidth : 0
      const y = firstY + i * layout.lineHeight

      if (layer.shadow) {
        ctx.save()
        ctx.shadowColor = 'rgba(0,0,0,0.55)'
        ctx.shadowBlur = layer.size * 0.35
        ctx.shadowOffsetY = layer.size * 0.08
        ctx.fillStyle = layer.color
        ctx.fillText(line, x, y)
        ctx.restore()
      }
      if (layer.stroke > 0) {
        ctx.lineJoin = 'round'
        ctx.lineWidth = layer.stroke * 2
        ctx.strokeStyle = layer.strokeColor
        ctx.strokeText(line, x, y)
      }
      ctx.fillStyle = layer.color
      ctx.fillText(line, x, y)
    }
    ctx.restore()
  }
}

/**
 * The on-screen box of a text layer, in output pixels.
 *
 * Used for the preview's drag handles and hit-testing. It measures with the
 * same font and padding as `drawTexts`, so a handle always sits on the text it
 * claims to control.
 */
export function textFrameRect(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  layer: RenderText,
): { x: number; y: number; width: number; height: number } {
  const layout = layoutText(ctx, layer)
  const width = (layout.blockWidth + layout.padX * 2) * layer.scale
  const height = (layout.blockHeight + layout.padY * 2) * layer.scale
  const anchorX = layer.x * ctx.canvas.width
  const anchorY = layer.y * ctx.canvas.height + layer.offsetY * layer.scale
  const x = layer.align === 'center' ? anchorX - width / 2 : layer.align === 'right' ? anchorX - width : anchorX
  return { x, y: anchorY - height / 2, width, height }
}

/**
 * Where the source lands inside the output, for overlay maths (caption
 * anchoring, drag handles, safe areas). Shares the geometry above so an
 * overlay can never be positioned against a different layout than the video
 * was drawn with.
 */
export function fitRect(
  source: { width: number; height: number },
  options: RenderOptions,
): { x: number; y: number; width: number; height: number } {
  const fit = frameScale(source, options)
  const width = source.width * fit
  const height = source.height * fit
  return { x: (options.width - width) / 2, y: (options.height - height) / 2, width, height }
}
