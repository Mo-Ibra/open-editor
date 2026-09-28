/**
 * The editing model. This is the whole product (PLAN.md §3).
 *
 * Two lanes, `video` and `audio`, each an ordered array. Splitting a clip
 * with audio attached, cutting the dead air out of a voiceover, or dropping a
 * video and keeping its sound are all the operations people actually perform —
 * and none of them are expressible if a clip carries its own audio implicitly.
 *
 * Rules this file obeys, and which the rest of the codebase depends on:
 *
 *  1. No `start` field on a clip. Timeline position is derived from array
 *     order, so position and order can never disagree.
 *  2. Durations are never stored. Everything reads from `clipDuration`.
 *  3. **Links are symmetric and optional.** Two clips sharing a `linkId` are
 *     edited together by default. Break the link and they are independent —
 *     which is the point, because sometimes you need to cut the picture and
 *     keep the sound.
 *  4. No Web APIs in this file. Pure data, so undo is a snapshot and this is
 *     directly testable.
 */

export type AssetId = string
export type ClipId = string
export type Lane = 'video' | 'audio'
export type LinkId = string

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
  /** False for an audio-only source — a voice memo, a music bed. It gets no
   *  video clip, because a black rectangle pretending to be a clip is worse
   *  than no clip. */
  hasVideo: boolean
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
  /** Which lane this lives in. A clip is in exactly one. */
  lane: Lane
  assetId: AssetId
  /** Source in-point, seconds. Fractional — this is what a human drags. */
  in: number
  /** Source out-point, seconds. */
  out: number
  transform?: ClipTransform
  /** Linear gain, 0–2. Absent means unity. */
  gain?: number
  muted?: boolean
  /**
   * Clips sharing a linkId are edited together. Absent means unlinked, which
   * is a first-class state, not an oversight: cutting the picture while
   * keeping the sound is a normal thing to want.
   */
  linkId?: LinkId
  /**
   * Silence before this clip, in seconds. Absent or 0 means "flush against the
   * previous clip", which is the default and what every edit produces.
   *
   * This is the one piece of position the model stores, and the distinction
   * matters. `offset` is an *edit* — a gap someone deliberately left — not a
   * position. It is never written as a consequence of a neighbouring clip
   * moving, so it cannot drift out of sync the way a stored `start` would.
   * Everything to the right shifts automatically, because position stays
   * derived (`clipStart`).
   *
   * Never negative. A clip may not overlap its predecessor; to move left past
   * one, reorder instead.
   */
  offset?: number
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
  /** The raw .srt text, verbatim. */
  src: string
  style: CaptionStyle
}

export interface Project {
  version: 2
  assets: Record<AssetId, Asset>
  /** Array order IS timeline order, per lane. */
  video: Clip[]
  audio: Clip[]
  captions?: CaptionTrack
}

// ---------------------------------------------------------------------------
// Derived quantities
// ---------------------------------------------------------------------------

export function clipDuration(clip: Clip): number {
  return Math.max(0, clip.out - clip.in)
}

/** Silence before a clip. Absent means flush. */
export function clipOffset(clip: Clip): number {
  return clip.offset && clip.offset > 0 ? clip.offset : 0
}

/**
 * Timeline offset of index `i` within one lane, in seconds.
 *
 * The clip's OWN offset is included, because a gap sits *before* the clip, not
 * after it: the space to the left of clip 5 belongs to clip 5's timeline
 * position. Forgetting that term makes `placeClip` set an offset that has no
 * effect on where the clip lands.
 */
export function clipStart(clips: Clip[], index: number): number {
  let t = 0
  for (let i = 0; i < index; i++) t += clipOffset(clips[i]!) + clipDuration(clips[i]!)
  const self = clips[index]
  return self ? t + clipOffset(self) : t
}

export function clipEnd(clips: Clip[], index: number): number {
  return clipStart(clips, index) + clipDuration(clips[index]!)
}

/**
 * Total span of a lane, gaps included.
 *
 * A gap is part of the timeline: the video holds black for it and the audio
 * holds silence. Summing only clip durations would report a timeline that is
 * shorter than the one the user is looking at, and the export would come out
 * short to match.
 */
export function laneDuration(clips: Clip[]): number {
  let t = 0
  for (const clip of clips) t += clipOffset(clip) + clipDuration(clip)
  return t
}

/**
 * The timeline is as long as its longest lane.
 *
 * Audio longer than the video does not extend the video — it would export
 * silence with no picture. The excess is simply not heard.
 */
export function projectDuration(project: Project): number {
  return Math.max(laneDuration(project.video), laneDuration(project.audio))
}

export function laneOf(project: Project, lane: Lane): Clip[] {
  return lane === 'video' ? project.video : project.audio
}

export interface ClipLocation {
  clip: Clip
  index: number
  /** Timeline position of the clip, seconds. */
  start: number
}

/**
 * Which clip is under timeline time `t` in this lane? Null means a gap.
 *
 * Uses the derived `clipStart` rather than accumulating durations, so a
 * position inside a gap correctly returns null. Accumulating here would claim
 * the previous clip covers the silence, and preview would show a frame where
 * the timeline is empty.
 */
export function clipAtLane(clips: Clip[], t: number): ClipLocation | null {
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]!
    const start = clipStart(clips, i)
    if (t >= start && t < start + clipDuration(clip)) return { clip, index: i, start }
  }
  return null
}

/** Source time within the asset for a timeline position. */
export function sourceTimeAt(loc: ClipLocation, t: number): number {
  return loc.clip.in + (t - loc.start)
}

// ---------------------------------------------------------------------------
// Boundary arithmetic
//
// `in`/`out` are floats because a human drags them. They are converted to
// integer frames and integer samples EXACTLY ONCE, at export time, and the
// export loops never do float math. Accumulating floats across 200 clips is
// the most common source of A/V drift (§6.1).
// ---------------------------------------------------------------------------

export function toSampleIndex(seconds: number, sampleRate: number): number {
  return Math.round(seconds * sampleRate)
}

export function toFrameIndex(seconds: number, frameRate: number): number {
  return Math.round(seconds * frameRate)
}

export function clampClip(clip: Clip, asset: Asset): Clip {
  const inPoint = clamp(clip.in, 0, asset.duration)
  const outPoint = clamp(clip.out, inPoint, asset.duration)
  return outPoint > inPoint ? { ...clip, in: inPoint, out: outPoint } : { ...clip, in: inPoint, out: inPoint }
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

/** Find a clip by id in either lane. */
export function findClip(project: Project, clipId: ClipId): { clip: Clip; lane: Lane; index: number } | null {
  for (const lane of ['video', 'audio'] as const) {
    const index = laneOf(project, lane).findIndex((c) => c.id === clipId)
    if (index >= 0) return { clip: laneOf(project, lane)[index]!, lane, index }
  }
  return null
}

/** The other half of a linked pair, or null when the clip is unlinked. */
export function linkedPartner(project: Project, clip: Clip): Clip | null {
  if (!clip.linkId) return null
  for (const lane of ['video', 'audio'] as const) {
    for (const other of laneOf(project, lane)) {
      if (other.id !== clip.id && other.linkId === clip.linkId) return other
    }
  }
  return null
}

export function isLinked(project: Project, clip: Clip): boolean {
  return linkedPartner(project, clip) !== null
}

/** Break a link in both directions. Afterwards the pair is independent. */
export function breakLink(project: Project, clip: Clip): Project {
  if (!clip.linkId) return project
  return {
    ...project,
    video: project.video.map((c) => (c.linkId === clip.linkId ? { ...c, linkId: undefined } : c)),
    audio: project.audio.map((c) => (c.linkId === clip.linkId ? { ...c, linkId: undefined } : c)),
  }
}

// ---------------------------------------------------------------------------
// Editing operations
//
// Each returns a new Project. Nothing re-encodes and nothing mutates a source
// file, so every one of them is free.
// ---------------------------------------------------------------------------

export interface AddAssetOptions {
  /** Include a video clip. False for an audio-only asset. */
  video: boolean
  /** Include an audio clip. False for a video-only asset. */
  audio: boolean
}

/**
 * Append a source file to the timeline.
 *
 * A file with both picture and sound produces a *linked pair*: two clips
 * sharing one `linkId`, so splitting cuts both. An audio-only file produces
 * an audio clip alone, unlinked, because there is nothing to link it to.
 */
export function appendAsset(project: Project, assetId: AssetId, asset: Asset): Project {
  // Only link when there is genuinely a pair to link.
  const linked = asset.hasVideo && asset.hasAudio
  const linkId = linked ? newId('lnk') : undefined
  const video: Clip[] =
    asset.hasVideo && asset.duration > 0
      ? [{ id: newId('clp'), lane: 'video', assetId, in: 0, out: asset.duration, ...(linkId ? { linkId } : {}) }]
      : []
  const audio: Clip[] =
    asset.hasAudio
      ? [{ id: newId('clp'), lane: 'audio', assetId, in: 0, out: asset.duration, ...(linkId ? { linkId } : {}) }]
      : []

  return {
    ...project,
    video: [...project.video, ...video],
    audio: [...project.audio, ...audio],
  }
}

/** Remove one clip. Linked partners survive — deleting is per-lane. */
export function removeClip(project: Project, lane: Lane, index: number): Project {
  const clips = laneOf(project, lane).filter((_, i) => i !== index)
  return { ...project, [lane]: clips } as Project
}

/**
 * Reorder. The moved clip lands flush against whatever is now before it.
 *
 * A gap is something you place deliberately; a reorder is a rearrangement, and
 * carrying an old offset into a new slot would leave an arbitrary hole. To
 * leave a gap, drag the clip — that is `placeClip`.
 */
export function moveClip(project: Project, lane: Lane, from: number, to: number): Project {
  const clips = laneOf(project, lane)
  if (from === to || from < 0 || to < 0 || from >= clips.length || to >= clips.length) return project
  const next = clips.slice()
  const [clip] = next.splice(from, 1)
  next.splice(to, 0, { ...clip!, offset: 0 })
  return { ...project, [lane]: next } as Project
}

/**
 * Move a clip so it *starts* at `start`, leaving a gap if it moves right.
 *
 * Only the moved clip's own offset changes, so nothing to its left shifts and
 * nothing to its right needs updating — position stays derived. Moving left is
 * clamped: a clip may not overlap its predecessor, and a negative offset would
 * push the whole lane before zero.
 */
export function placeClip(project: Project, lane: Lane, index: number, start: number): Project {
  const clips = laneOf(project, lane)
  const clip = clips[index]
  if (!clip) return project

  const floor = index === 0 ? 0 : clipEnd(clips, index - 1)
  const target = Math.max(floor, start)

  const next = clips.slice()
  next[index] = { ...clip, offset: target - clipStart(clips, index) }
  return { ...project, [lane]: next } as Project
}

/**
 * Copy clips, placing each copy immediately after its original.
 *
 * A linked pair is copied *as a pair*: both halves get one fresh `linkId`, so
 * the duplicate can be split or trimmed without dragging the original along.
 * Giving each half its own id would silently break the link the moment anyone
 * touched the copy.
 *
 * Each half is placed against its own lane, so a copy can overlap the clip
 * that followed the original. That is not a new hazard — dragging a clip right
 * already allows it — and resolving it here would mean inventing a ripple rule
 * the model deliberately does not have.
 */
export function duplicateClips(project: Project, clipIds: Iterable<ClipId>): Project {
  const ids = new Set(clipIds)
  if (ids.size === 0) return project

  // One new link id per original link, shared by the copies of both halves.
  const copyLink = new Map<LinkId, LinkId>()
  const nextCopyId = (clip: Clip): LinkId => {
    if (!clip.linkId) return newId('lnk')
    let made = copyLink.get(clip.linkId)
    if (!made) {
      made = newId('lnk')
      copyLink.set(clip.linkId, made)
    }
    return made
  }

  // Only allocate once something actually matches, so a request for a clip
  // that is not there returns the very same project. Callers rely on that to
  // skip a history entry for a no-op.
  let out: Project | null = null
  let copied = 0

  // Walk each lane front to back and insert directly after the source clip, so
  // later indices are never invalidated by an earlier insert.
  for (const lane of ['video', 'audio'] as const) {
    const source = project[lane]
    const next: Clip[] = []
    for (let index = 0; index < source.length; index += 1) {
      const clip = source[index]!
      next.push(clip)
      if (!ids.has(clip.id)) continue
      if (!out) out = { ...project, video: project.video.slice(), audio: project.audio.slice() }

      // The copy starts where the original ends.
      const start = clipStart(source, index) + clipDuration(clip)
      const copy: Clip = {
        ...clip,
        id: newId('clp'),
        linkId: clip.linkId ? nextCopyId(clip) : undefined,
      }
      // Offset is relative to the end of whatever precedes the *copy*, which is
      // the original — so this is a plain duration, not a timeline lookup.
      next.push({ ...copy, offset: start - clipEnd(source, index) })
      copied += 1
    }
    if (out) out[lane] = next
  }

  return copied === 0 ? project : out!
}

export function trimClip(project: Project, lane: Lane, index: number, inPoint: number, outPoint: number): Project {
  const clips = laneOf(project, lane)
  const clip = clips[index]
  if (!clip) return project
  const asset = project.assets[clip.assetId]
  const inClamped = asset ? clamp(inPoint, 0, asset.duration) : inPoint
  const outClamped = asset ? clamp(outPoint, inClamped, asset.duration) : Math.max(inClamped, outPoint)
  const next = clips.slice()
  next[index] = { ...clip, in: inClamped, out: outClamped }
  return { ...project, [lane]: next } as Project
}

/** Minimum clip length. Below this, a clip divides by zero somewhere. */
const MIN_CLIP = 0.04

/**
 * Split a clip at a timeline position, and its linked partner along with it.
 *
 * Each half is split against *its own* start and in-point. A linked pair can
 * legitimately be out of alignment — you may have slid the audio — and
 * splitting the audio at the video's source time would land in the wrong
 * place.
 */
export function splitLinked(project: Project, lane: Lane, index: number, timelineT: number): Project {
  const clips = laneOf(project, lane)
  const clip = clips[index]
  if (!clip) return project

  const local = timelineT - clipStart(clips, index)
  if (local < MIN_CLIP || local > clipDuration(clip) - MIN_CLIP) return project

  const left: Clip = { ...clip, out: clip.in + local }
  // The right half starts where the left ends, so it carries no offset — its
  // position comes from being next in the array.
  const right: Clip = { ...clip, id: newId('clp'), in: clip.in + local, offset: 0 }

  let next = { ...project, [lane]: [...clips.slice(0, index), left, right, ...clips.slice(index + 1)] } as Project

  const partner = linkedPartner(project, clip)
  if (partner) {
    const otherLane: Lane = partner.lane
    const otherClips = laneOf(next, otherLane)
    const partnerIndex = otherClips.findIndex((c) => c.id === partner.id)
    if (partnerIndex >= 0) {
      const partnerLocal = timelineT - clipStart(otherClips, partnerIndex)
      const p = otherClips[partnerIndex]!
      // Respect the same minimum on the partner: a split that is valid for
      // video but produces a 10 ms audio clip is not a split anyone wanted.
      if (partnerLocal >= MIN_CLIP && partnerLocal <= clipDuration(p) - MIN_CLIP) {
        const pLeft: Clip = { ...p, out: p.in + partnerLocal }
        const pRight: Clip = { ...p, id: newId('clp'), in: p.in + partnerLocal, offset: 0 }
        const other = [...otherClips.slice(0, partnerIndex), pLeft, pRight, ...otherClips.slice(partnerIndex + 1)]
        next = { ...next, [otherLane]: other } as Project
      }
    }
  }

  return next
}

export function setTransform(project: Project, clipId: ClipId, transform: ClipTransform): Project {
  const found = findClip(project, clipId)
  if (!found) return project
  const next = laneOf(project, found.lane).slice()
  next[found.index] = { ...next[found.index]!, transform }
  return { ...project, [found.lane]: next } as Project
}

export function setClipGain(project: Project, clipId: ClipId, gain: number): Project {
  const found = findClip(project, clipId)
  if (!found) return project
  const next = laneOf(project, found.lane).slice()
  next[found.index] = { ...next[found.index]!, gain: clamp(gain, 0, 2) }
  return { ...project, [found.lane]: next } as Project
}

/**
 * Mute or unmute a clip.
 *
 * **Audio lane only.** A video clip has nothing to mute, and letting one carry
 * a `muted` flag is worse than a no-op: the flag shows up in the UI as a mute
 * badge on a clip with no sound, and it silently changes the audio mixer's
 * gain for a clip that was never in it. Refusing here means no caller can
 * produce that state, rather than relying on each one to remember the rule.
 */
export function toggleMute(project: Project, clipId: ClipId): Project {
  const found = findClip(project, clipId)
  if (!found || found.lane !== 'audio') return project
  const next = laneOf(project, found.lane).slice()
  next[found.index] = { ...next[found.index]!, muted: !next[found.index]!.muted }
  return { ...project, [found.lane]: next } as Project
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export function emptyProject(): Project {
  return { version: 2, assets: {}, video: [], audio: [] }
}

/**
 * Load with a hand-written guard rather than pulling in a schema library.
 * A malformed project must produce a clear error, never a half-built world.
 */
export function parseProject(text: string): Project {
  const data: unknown = JSON.parse(text)
  if (typeof data !== 'object' || data === null) throw new Error('Project is not an object')
  const p = data as Partial<Project>

  if (p.version !== 2) {
    throw new Error(
      p.version === 1
        ? 'This project was saved before the two-lane format and cannot be opened.'
        : `Unsupported project version: ${String(p.version)}`,
    )
  }
  if (typeof p.assets !== 'object' || p.assets === null) throw new Error('Project has no assets map')
  if (!Array.isArray(p.video) || !Array.isArray(p.audio)) throw new Error('Project must have a video and an audio lane')

  for (const [lane, clips] of [['video', p.video], ['audio', p.audio]] as const) {
    for (const clip of clips) {
      if (typeof clip.id !== 'string') throw new Error(`A ${lane} clip is missing its id`)
      if (typeof clip.assetId !== 'string') throw new Error(`Clip ${clip.id} missing assetId`)
      if (typeof clip.in !== 'number' || typeof clip.out !== 'number') {
        throw new Error(`Clip ${clip.id} has non-numeric in/out`)
      }
    }
  }

  return {
    version: 2,
    assets: p.assets,
    video: p.video,
    audio: p.audio,
    ...(p.captions ? { captions: p.captions } : {}),
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
