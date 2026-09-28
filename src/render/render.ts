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

export interface RenderOptions {
  width: number
  height: number
  background?: string
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
 * Geometry: the source is fitted (letterboxed, never cropped) into the output,
 * then the clip transform is applied about the centre of the output. A scale
 * above 1 therefore zooms in on the centre of the frame, which is the only
 * interpretation a user ever wants from "zoom".
 */
export function renderFrame(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  source: SourceImage,
  clip: RenderClip,
  options: RenderOptions,
): void {
  const { width, height, background = '#000' } = options

  ctx.save()
  ctx.fillStyle = background
  ctx.fillRect(0, 0, width, height)

  const fit = Math.min(width / source.width, height / source.height)
  const drawWidth = source.width * fit
  const drawHeight = source.height * fit

  const transform = clip.transform
  const scale = transform?.scale ?? 1

  ctx.translate(width / 2 + (transform?.x ?? 0), height / 2 + (transform?.y ?? 0))
  if (scale !== 1) ctx.scale(scale, scale)

  ctx.drawImage(source.image, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight)
  ctx.restore()
}

/** Draw an empty output frame — a gap in the timeline, or a missing source. */
export function renderBlank(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  options: RenderOptions,
): void {
  ctx.save()
  ctx.fillStyle = options.background ?? '#000'
  ctx.fillRect(0, 0, options.width, options.height)
  ctx.restore()
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
  const fit = Math.min(options.width / source.width, options.height / source.height)
  const width = source.width * fit
  const height = source.height * fit
  return { x: (options.width - width) / 2, y: (options.height - height) / 2, width, height }
}
