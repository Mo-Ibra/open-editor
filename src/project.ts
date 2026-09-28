/**
 * The editing model. This is the whole product (see PLAN.md §3).
 *
 * Rules this file obeys, and which the rest of the codebase depends on:
 *  1. No `start` field on a clip. Timeline position is derived from array
 *     order, so position and order can never disagree.
 *  2. Durations are never stored. Everything reads from `clipDuration`.
 *  3. No Web APIs in this file. It is pure data, so it is trivially
 *     testable and undo is a structured clone away.
 */

export type AssetId = string
export type ClipId = string

export type Rotation = 0 | 90 | 180 | 270

export interface Asset {
  id: AssetId
  name: string
  /** Full duration of the source file, in seconds. */
  duration: number
  /** Display dimensions, after rotation and pixel-aspect correction. */
  width: number
  height: number
  rotation: Rotation
  /** Best-guess nominal frame rate. Meaningless for VFR assets. */
  frameRate: number
  /** True when frame durations are irregular — i.e. most screen recordings. */
  variableFrameRate: boolean
  hasAudio: boolean
  audioSampleRate: number
  audioChannels: number
  videoCodec: string | null
  audioCodec: string | null
  size: number
}

export interface ClipTransform {
  scale: number
  x: number
  y: number
}

export interface Clip {
  id: ClipId
  assetId: AssetId
  /** Source in-point, seconds. Fractional — this is what a human drags. */
  in: number
  /** Source out-point, seconds. */
  out: number
  transform?: ClipTransform
}

export type CaptionPosition = 'top' | 'center' | 'bottom'

export interface CaptionStyle {
  font: string
  size: number
  color: string
  background: string
  position: CaptionPosition
}

export interface CaptionTrack {
  /** The raw .srt text, verbatim. Parsed lazily, cached by mtime-free key. */
  src: string
  style: CaptionStyle
}

export interface Project {
  version: 1
  assets: Record<AssetId, Asset>
  /** Array order IS timeline order. */
  clips: Clip[]
  captions?: CaptionTrack
}

// ---------------------------------------------------------------------------
// Derived quantities. These three functions replace every stored field that
// could drift. Nothing else in the codebase should compute positions.
// ---------------------------------------------------------------------------

export function clipDuration(clip: Clip): number {
  return Math.max(0, clip.out - clip.in)
}

/** Timeline offset of clip `index`, in seconds. */
export function clipStart(clips: Clip[], index: number): number {
  let t = 0
  for (let i = 0; i < index; i++) t += clipDuration(clips[i]!)
  return t
}

export function projectDuration(project: Project): number {
  let t = 0
  for (const clip of project.clips) t += clipDuration(clip)
  return t
}

// ---------------------------------------------------------------------------
// Boundary arithmetic
//
// `in`/`out` are floats because a human drags them. They are converted to
// integer frames and integer samples EXACTLY ONCE, at export time, and the
// export loop never does float math. Accumulating floats across 200 clips is
// the single most common source of A/V drift (PLAN.md §6.1).
// ---------------------------------------------------------------------------

export function toSampleIndex(seconds: number, sampleRate: number): number {
  return Math.round(seconds * sampleRate)
}

export function toFrameIndex(seconds: number, frameRate: number): number {
  return Math.round(seconds * frameRate)
}

/** Clamp a clip's in/out to its asset, and guarantee out > in. */
export function normalizeClip(clip: Clip, asset: Asset): Clip {
  const inPoint = clamp(clip.in, 0, asset.duration)
  const outPoint = clamp(clip.out, inPoint, asset.duration)
  return outPoint > inPoint ? { ...clip, in: inPoint, out: outPoint } : { ...clip, in: inPoint, out: inPoint }
}

// ---------------------------------------------------------------------------
// Timeline lookup
// ---------------------------------------------------------------------------

export interface ClipLocation {
  clip: Clip
  /** Index into `project.clips`. */
  index: number
  /** Timeline position of the clip, seconds. */
  start: number
}

/** Which clip is under timeline time `t`? Null means a gap. */
export function clipAt(project: Project, t: number): ClipLocation | null {
  let start = 0
  for (let i = 0; i < project.clips.length; i++) {
    const clip = project.clips[i]!
    const d = clipDuration(clip)
    if (t < start + d) return { clip, index: i, start }
    start += d
  }
  return null
}

/** Source time within the asset for a timeline position. */
export function sourceTimeAt(loc: ClipLocation, t: number): number {
  return loc.clip.in + (t - loc.start)
}

// ---------------------------------------------------------------------------
// Editing operations. Each one is O(n) at worst and mutates nothing — the
// caller swaps in the returned array, which keeps undo a snapshot.
// ---------------------------------------------------------------------------

export function splitClip(clips: Clip[], index: number, timelineT: number): Clip[] {
  const clip = clips[index]
  if (!clip) return clips

  const local = timelineT - clipStart(clips, index)
  const sourceT = clip.in + local
  // Refuse a split that lands within a frame of either edge; it would produce
  // a zero-length clip and a divide-by-zero later.
  const min = 0.04
  if (local < min || local > clipDuration(clip) - min) return clips

  const left: Clip = { ...clip, out: sourceT }
  const right: Clip = { ...clip, id: newId('clp'), in: sourceT }
  return [...clips.slice(0, index), left, right, ...clips.slice(index + 1)]
}

export function removeClip(clips: Clip[], index: number): Clip[] {
  return clips.filter((_, i) => i !== index)
}

export function moveClip(clips: Clip[], from: number, to: number): Clip[] {
  if (from === to || from < 0 || to < 0 || from >= clips.length || to >= clips.length) return clips
  const next = clips.slice()
  const [clip] = next.splice(from, 1)
  next.splice(to, 0, clip!)
  return next
}

export function trimClip(clips: Clip[], index: number, inPoint: number, outPoint: number): Clip[] {
  const clip = clips[index]
  if (!clip) return clips
  const next = clips.slice()
  next[index] = { ...clip, in: inPoint, out: Math.max(inPoint, outPoint) }
  return next
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

export function emptyProject(): Project {
  return { version: 1, assets: {}, clips: [] }
}

/**
 * Load with a hand-written guard rather than pulling in a schema library.
 * A malformed project must produce a clear error, never a half-built world.
 */
export function parseProject(text: string): Project {
  const data: unknown = JSON.parse(text)
  if (typeof data !== 'object' || data === null) throw new Error('Project is not an object')
  const p = data as Partial<Project>

  if (p.version !== 1) throw new Error(`Unsupported project version: ${String(p.version)}`)
  if (typeof p.assets !== 'object' || p.assets === null) throw new Error('Project has no assets map')
  if (!Array.isArray(p.clips)) throw new Error('Project has no clips array')

  for (const clip of p.clips) {
    if (typeof clip.id !== 'string') throw new Error('Clip missing id')
    if (typeof clip.assetId !== 'string') throw new Error(`Clip ${clip.id} missing assetId`)
    if (typeof clip.in !== 'number' || typeof clip.out !== 'number') {
      throw new Error(`Clip ${clip.id} has non-numeric in/out`)
    }
  }

  return {
    version: 1,
    assets: p.assets as Record<AssetId, Asset>,
    clips: p.clips as Clip[],
    ...(p.captions ? { captions: p.captions } : {}),
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
