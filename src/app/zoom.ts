/**
 * Timeline zoom.
 *
 * Pure geometry, deliberately separated from the component that listens to the
 * wheel. Zooming has three separate decisions — how far, bounded to what, and
 * where the scroll ends up — and only the last one needs the DOM. Keeping the
 * first two here means they can be tested without a browser, which matters
 * because the "does the thing under my cursor stay put" property is the whole
 * point of the feature and is invisible to a screenshot.
 */

/**
 * Bounds, in pixels per second.
 *
 * The preview's zoom slider uses exactly this range, and clamping to it here
 * means the slider and the wheel can never disagree — dragging the slider to
 * 400 and then scrolling must not silently jump to 1200.
 */
export const ZOOM_MIN = 10
export const ZOOM_MAX = 400
export const ZOOM_DEFAULT = 80

/**
 * How much one wheel notch zooms.
 *
 * Expressed as a *ratio*, not a pixel delta, so a notch feels identical at
 * 10 px/s and at 400 px/s. A fixed pixel step means zooming gets sluggish as
 * you go in, and the user cannot tell whether the wheel stopped working or the
 * app did.
 */
const ZOOM_RATIO_PER_NOTCH = 1.15

/**
 * One wheel notch, in pixels.
 *
 * The reference unit. Everything else is normalised into it, so a mouse, a
 * line-mode wheel and a page-mode wheel all agree on what "one notch" is.
 */
const NOTCH_PIXELS = 100

/** Browsers report ~3 lines per wheel click, and a click is one notch. */
const LINE_TO_PIXELS = NOTCH_PIXELS / 3

/** A page-mode delta of 1 is a whole page scroll, which is also one notch. */
const PAGE_TO_PIXELS = NOTCH_PIXELS

/**
 * `deltaY` → a zoom multiplier.
 *
 * Some platforms report wheel movement in lines (`deltaMode === 1`) or pages
 * (2) rather than pixels. Normalising first is what keeps one notch one notch
 * across devices — without it, a line-mode wheel zooms at a sixth of the rate
 * and looks broken.
 */
export function zoomFactor(deltaY: number, deltaMode: number): number {
  const pixels =
    deltaMode === 1 ? deltaY * LINE_TO_PIXELS : deltaMode === 2 ? deltaY * PAGE_TO_PIXELS : deltaY
  return Math.pow(ZOOM_RATIO_PER_NOTCH, -pixels / NOTCH_PIXELS)
}

/**
 * Clamp to the zoom range.
 *
 * NaN falls back to the default, but ±Infinity is clamped like any other
 * number: `Math.min`/`Math.max` handle it correctly, and returning the default
 * for +Infinity would mean a runaway slider value silently snapped the timeline
 * back to 80px/s instead of stopping at the maximum.
 */
export function clampZoom(zoom: number): number {
  if (Number.isNaN(zoom)) return ZOOM_DEFAULT
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(zoom)))
}

export interface ZoomAnchor {
  /** Scroll offset before zooming. */
  scrollLeft: number
  /** Pointer position inside the visible track, in pixels from its left edge. */
  localX: number
  zoomBefore: number
  zoomAfter: number
}

/**
 * Where the scroll should land so the time under the pointer stays under it.
 *
 * This is the detail that decides whether the feature feels right. Zooming
 * about the timeline origin instead makes whatever you were looking at slide
 * out from under the cursor, which reads as the app ignoring you — the same
 * complaint as a playhead that jumps when you drag it.
 */
export function scrollLeftAfterZoom({ scrollLeft, localX, zoomBefore, zoomAfter }: ZoomAnchor): number {
  const timeUnderCursor = (scrollLeft + localX) / zoomBefore
  return timeUnderCursor * zoomAfter - localX
}
