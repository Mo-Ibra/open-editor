/**
 * Text overlays: a title, a lower-third, a location plate.
 *
 * A text clip is deliberately NOT a media clip. It has no asset, no source
 * in/out, and no `trackId` — it lives on its own single timeline lane beside
 * the picture, because a title is an annotation of the edit rather than a
 * stream of pixels the decoder has to produce. Keeping it separate is what
 * lets a still title be three seconds long without pretending to be a three
 * second file, and what lets the renderer treat it as one more thing drawn
 * into the same frame (`docs/decisions/0001-one-render-function.md`).
 *
 * Unlike a media clip, a text clip DOES store `start`. That is not a
 * contradiction of the model's "position is derived" rule: a media clip's
 * position is a consequence of the neighbours it is butted against, while a
 * title is free-floating and is placed by the user at a time, the way a
 * caption is. There is nothing for its position to drift relative to.
 *
 * This file is pure data and pure functions: no canvas, no DOM. The one
 * dependency, `RenderText`, is a type, so it is erased at build time and the
 * model stays testable in Node.
 */

import type { RenderText } from '../render/render.js'

export type TextId = string
export type TextAnimation = 'none' | 'fade' | 'rise' | 'pop' | 'typewriter'
export type TextAlign = 'left' | 'center' | 'right'
export type TextFont = 'sans' | 'serif' | 'mono' | 'display'

export interface TextStyle {
  /** Cap height as a fraction of the frame height, so a title scales with the export. */
  size: number
  color: string
  /** 100–900. */
  weight: number
  italic: boolean
  align: TextAlign
  lineHeight: number
  /** Extra letter spacing, in em (multiples of the font size). */
  tracking: number
  /** A plate behind the text, or null for none. */
  background: string | null
  /** Plate padding, as a fraction of the frame height. */
  padding: number
  shadow: boolean
  /** Outline width as a fraction of the frame height; 0 means none. */
  stroke: number
  strokeColor: string
  font: TextFont
}

export interface TextClip {
  id: TextId
  text: string
  /** Timeline seconds. Free-floating, unlike a media clip. */
  start: number
  duration: number
  /** Anchor point, normalised to the frame: 0 is the left/top edge, 1 the right/bottom. */
  x: number
  y: number
  style: TextStyle
  animation: TextAnimation
  /** Seconds the in (and, for fade, out) animation takes. */
  animationDuration: number
}

export const TEXT_DURATION_DEFAULT = 3
export const TEXT_DURATION_MIN = 0.2
export const TEXT_SIZE_MIN = 0.02
export const TEXT_SIZE_MAX = 0.35

/**
 * Bundled stacks rather than webfonts.
 *
 * A font that has to be fetched is a font that is missing on the first frame
 * or on an offline export, and a title that silently falls back to a different
 * face is worse than one that never claimed to be a particular face. These are
 * long-lived system stacks, plus Inter where the app already assumes it.
 */
export const TEXT_FONTS: Record<TextFont, string> = {
  sans: "'Inter', 'Helvetica Neue', Arial, sans-serif",
  serif: "'Iowan Old Style', 'Times New Roman', Georgia, serif",
  mono: "'SFMono-Regular', 'JetBrains Mono', Menlo, Consolas, monospace",
  display: "'Avenir Next', 'Futura', 'Trebuchet MS', sans-serif",
}

export const TEXT_ANIMATIONS: { id: TextAnimation; label: string }[] = [
  { id: 'none', label: 'None' },
  { id: 'fade', label: 'Fade' },
  { id: 'rise', label: 'Rise' },
  { id: 'pop', label: 'Pop' },
  { id: 'typewriter', label: 'Typewriter' },
]

export function defaultTextStyle(): TextStyle {
  return {
    size: 0.09,
    color: '#ffffff',
    weight: 700,
    italic: false,
    align: 'center',
    lineHeight: 1.15,
    tracking: 0,
    background: null,
    padding: 0.018,
    shadow: true,
    stroke: 0,
    strokeColor: '#000000',
    font: 'sans',
  }
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value
}

function clamp01(value: number): number {
  return clamp(value, 0, 1)
}

/**
 * The shape a caller may hand `createTextClip`: everything but the id is
 * optional, and `style` is a partial because a caller that only wants to change
 * the colour should not have to restate the other thirteen style fields.
 */
export type TextInit = Partial<Omit<TextClip, 'id' | 'style'>> & { style?: Partial<TextStyle> }

export function createTextClip(id: TextId, start: number, overrides: TextInit = {}): TextClip {
  return {
    id,
    text: overrides.text ?? 'Your text',
    start: Math.max(0, start),
    duration: Math.max(TEXT_DURATION_MIN, overrides.duration ?? TEXT_DURATION_DEFAULT),
    x: clamp(overrides.x ?? 0.5, 0, 1),
    y: clamp(overrides.y ?? 0.82, 0, 1),
    style: { ...defaultTextStyle(), ...(overrides.style ?? {}) },
    animation: overrides.animation ?? 'none',
    animationDuration: clamp(overrides.animationDuration ?? 0.6, 0.05, 5),
  }
}

/** Fill any missing style field with its default. Used when reading old files. */
export function normaliseStyle(raw: Partial<TextStyle> | undefined): TextStyle {
  const fallback = defaultTextStyle()
  if (!raw) return fallback
  return {
    size: typeof raw.size === 'number' ? raw.size : fallback.size,
    color: typeof raw.color === 'string' ? raw.color : fallback.color,
    weight: typeof raw.weight === 'number' ? raw.weight : fallback.weight,
    italic: typeof raw.italic === 'boolean' ? raw.italic : fallback.italic,
    align: raw.align === 'left' || raw.align === 'center' || raw.align === 'right' ? raw.align : fallback.align,
    lineHeight: typeof raw.lineHeight === 'number' ? raw.lineHeight : fallback.lineHeight,
    tracking: typeof raw.tracking === 'number' ? raw.tracking : fallback.tracking,
    background: typeof raw.background === 'string' ? raw.background : null,
    padding: typeof raw.padding === 'number' ? raw.padding : fallback.padding,
    shadow: typeof raw.shadow === 'boolean' ? raw.shadow : fallback.shadow,
    stroke: typeof raw.stroke === 'number' ? raw.stroke : fallback.stroke,
    strokeColor: typeof raw.strokeColor === 'string' ? raw.strokeColor : fallback.strokeColor,
    font: raw.font === 'sans' || raw.font === 'serif' || raw.font === 'mono' || raw.font === 'display' ? raw.font : fallback.font,
  }
}

export interface TextPatch {
  text?: string
  start?: number
  duration?: number
  x?: number
  y?: number
  animation?: TextAnimation
  animationDuration?: number
  style?: Partial<TextStyle>
}

/**
 * Apply a patch, returning a new array. Pure: the store swaps the whole array,
 * so undo is a snapshot and nothing can be mutated out from under a render.
 */
export function updateTextClip(texts: readonly TextClip[], id: TextId, patch: TextPatch): TextClip[] {
  return texts.map((clip) => {
    if (clip.id !== id) return clip
    const next: TextClip = { ...clip }
    if (patch.text !== undefined) next.text = patch.text
    if (patch.start !== undefined) next.start = Math.max(0, patch.start)
    if (patch.duration !== undefined) next.duration = Math.max(TEXT_DURATION_MIN, patch.duration)
    if (patch.x !== undefined) next.x = clamp(patch.x, 0, 1)
    if (patch.y !== undefined) next.y = clamp(patch.y, 0, 1)
    if (patch.animation !== undefined) next.animation = patch.animation
    if (patch.animationDuration !== undefined) next.animationDuration = clamp(patch.animationDuration, 0.05, 5)
    if (patch.style) next.style = { ...clip.style, ...patch.style }
    return next
  })
}

export function removeTextClip(texts: readonly TextClip[], id: TextId): TextClip[] {
  return texts.filter((clip) => clip.id !== id)
}

export function textEnd(clip: TextClip): number {
  return clip.start + clip.duration
}

/** The topmost text covering `t`, or null. Later entries win, as they draw on top. */
export function textAt(texts: readonly TextClip[], t: number): TextClip | null {
  for (let i = texts.length - 1; i >= 0; i--) {
    const clip = texts[i]!
    if (t >= clip.start && t <= clip.start + clip.duration) return clip
  }
  return null
}

function easeOutCubic(x: number): number {
  const p = 1 - x
  return 1 - p * p * p
}

function easeOutBack(x: number): number {
  const c1 = 1.70158
  const c3 = c1 + 1
  const p = x - 1
  return 1 + c3 * p * p * p + c1 * p * p
}

/**
 * The text as it should look at timeline time `t`, in output pixels.
 *
 * Returns null outside the clip's span, which is what keeps an overlay off the
 * frame entirely rather than sitting at zero opacity — a distinction that
 * matters because zero-opacity text still costs a measure and a layout.
 *
 * `frameHeight` converts the style's normalised sizes (fractions of the frame)
 * into the pixels the renderer draws with. Passing the *output* height is what
 * makes a preview and a 4K export agree about how big a title is.
 */
export function textFrameAt(clip: TextClip, t: number, frameHeight: number): RenderText | null {
  const local = t - clip.start
  if (local < 0 || local > clip.duration) return null

  const style = clip.style
  const size = clamp(style.size, 0.005, 1) * frameHeight
  const anim = Math.max(0.001, clip.animationDuration)
  const inP = clamp01(local / anim)
  const outP = clamp01((clip.duration - local) / anim)

  let opacity = 1
  let offsetY = 0
  let scale = 1
  let reveal = 1

  switch (clip.animation) {
    case 'fade':
      opacity = Math.min(inP, outP)
      break
    case 'rise':
      opacity = inP
      offsetY = (1 - easeOutCubic(inP)) * size * 1.2
      break
    case 'pop':
      opacity = clamp01(inP * 1.6)
      scale = Math.max(0, easeOutBack(inP))
      break
    case 'typewriter':
      reveal = clamp01(local / anim)
      break
    default:
      break
  }

  return {
    text: clip.text,
    x: clip.x,
    y: clip.y,
    align: style.align,
    font: TEXT_FONTS[style.font] ?? TEXT_FONTS.sans,
    weight: style.weight,
    italic: style.italic,
    size,
    lineHeight: style.lineHeight,
    tracking: style.tracking * size,
    color: style.color,
    background: style.background,
    padding: style.padding * frameHeight,
    shadow: style.shadow,
    stroke: style.stroke * frameHeight,
    strokeColor: style.strokeColor,
    opacity,
    offsetY,
    scale,
    reveal,
  }
}

/** Every text visible at `t`, in draw order (first is furthest back). */
export function textLayersAt(texts: readonly TextClip[], t: number, frameHeight: number): RenderText[] {
  const layers: RenderText[] = []
  for (const clip of texts) {
    const frame = textFrameAt(clip, t, frameHeight)
    if (frame) layers.push(frame)
  }
  return layers
}
