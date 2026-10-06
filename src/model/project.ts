/**
 * The editing model. This is the whole product (docs/data-model.md).
 *
 * N tracks, each typed 'video' or 'audio', each an ordered array. A file with
 * picture and sound becomes a linked pair across two tracks. Trimming the
 * picture while keeping the sound, or dropping a video and keeping its sound,
 * are all the operations people actually perform — and none of them are
 * expressible if a clip carries its own audio implicitly.
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
export type TrackId = string
export type TrackType = 'video' | 'audio'
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
  /**
   * True for a still image. It has a picture (`hasVideo: true`) but no decoder
   * and no inherent length — `duration` is a fixed default the editor assigns,
   * and the library hands the preview and export a single decoded frame for
   * any source time. Absent (undefined) on everything imported before images
   * existed, which is the same as false.
   */
  isImage?: boolean
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
  /** Which track this lives in. A clip is in exactly one. */
  trackId: TrackId
  assetId: AssetId
  /** Source in-point, seconds. Fractional — this is what a human drags. */
  in: number
  /** Source out-point, seconds. */
  out: number
  transform?: ClipTransform
  /** Linear gain, 0–2. Absent means unity. */
  gain?: number
  /**
   * Audio track only. See `toggleMute` — a video clip is refused rather than
   * carrying a meaningless flag.
   */
  muted?: boolean
  /**
   * Video track only: draw black for this clip, in the preview and in the
   * export, until it is shown again.
   *
   * The video counterpart of `muted`, and deliberately not the same field. A
   * single "hidden" flag on both tracks would allow a state where a clip is
   * neither audible nor visible, which is not a thing anyone can want and is
   * two flags to keep straight. Refusing the wrong track means no caller can
   * produce that state.
   */
  hidden?: boolean
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

export interface Track {
  id: TrackId
  type: TrackType
  /** Array order IS timeline order. */
  clips: Clip[]
}

export interface Project {
  version: 3
  assets: Record<AssetId, Asset>
  tracks: Track[]
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
 * Timeline offset of index `i` within one track, in seconds.
 *
 * The clip's OWN offset is included, because a gap sits *before* the clip, not
 * after it: the space to the left of clip 5 belongs to clip 5's timeline
 * position. Forgetting that term makes `placeClip` set an offset that has no
 * effect on where the clip lands.
 */
export function clipStart(clips: Clip[], index: number): number {
  if (index <= 0) return clips[0] ? clipOffset(clips[0]) : 0
  let t = 0
  for (let i = 0; i < index; i++) t += clipOffset(clips[i]!) + clipDuration(clips[i]!)
  const self = clips[index]
  return self ? t + clipOffset(self) : t
}

/**
 * Every clip's timeline start, in one pass.
 *
 * `clipStart` sums the track from zero, which is free for a single lookup and
 * quadratic inside a loop — and the loops are everywhere. `clipAtLane` asked per
 * index on every preview frame, `collectTargets` per index on every trim
 * `pointermove`, `survivorsInRange` and `duplicateClips` per index on every drop
 * and every ⌘D, and the track's `<For>` asked per clip on every repaint. Measured
 * at 1.2 ms per `clipAtLane` call on a 1600-clip track, which is 72 ms of every
 * second of playback spent re-adding the same numbers.
 *
 * **The invariant is untouched.** Position is still derived from array order and
 * still stored nowhere; this is the same arithmetic with the running total hoisted
 * out of the inner loop. `shiftTrack` already did it this way for exactly this
 * reason, and said so.
 *
 * Prefer this whenever the answer is needed for more than one clip. For a single
 * index, `clipStart` is clearer and costs one pass either way.
 */
export function clipStarts(clips: Clip[]): number[] {
  const starts = new Array<number>(clips.length)
  let t = 0
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]!
    starts[i] = t + clipOffset(clip)
    t = starts[i]! + clipDuration(clip)
  }
  return starts
}

export function clipEnd(clips: Clip[], index: number): number {
  return clipStart(clips, index) + clipDuration(clips[index]!)
}

/**
 * Total span of a track, gaps included.
 *
 * A gap is part of the timeline: the video holds black for it and the audio
 * holds silence. Summing only clip durations would report a timeline that is
 * shorter than the one the user is looking at, and the export would come out
 * short to match.
 */
export function trackDuration(clips: Clip[]): number {
  let t = 0
  for (const clip of clips) t += clipOffset(clip) + clipDuration(clip)
  return t
}

/**
 * The timeline is as long as its longest track.
 *
 * Audio longer than the video does not extend the video — it would export
 * silence with no picture. The excess is simply not heard.
 */
export function projectDuration(project: Project): number {
  let max = 0
  for (const track of project.tracks) {
    const d = trackDuration(track.clips)
    if (d > max) max = d
  }
  return max
}

export function trackById(project: Project, trackId: TrackId): Clip[] {
  return project.tracks.find((t) => t.id === trackId)?.clips ?? []
}

export function trackTypeById(project: Project, trackId: TrackId): TrackType | null {
  return project.tracks.find((t) => t.id === trackId)?.type ?? null
}

export interface ClipLocation {
  clip: Clip
  index: number
  /** Timeline position of the clip, seconds. */
  start: number
}

/**
 * Which clip is under timeline time `t` in this track? Null means a gap.
 *
 * Uses the derived `clipStart` rather than accumulating durations, so a
 * position inside a gap correctly returns null. Accumulating here would claim
 * the previous clip covers the silence, and preview would show a frame where
 * the timeline is empty.
 *
 * **One pass, accumulating as it goes** — not `clipStart(clips, i)` per index.
 * Both compute the same thing, but this one sums the track prefix once instead of
 * once per clip, which is the difference between 0.03 ms and 1.2 ms on a
 * 1600-clip track. The preview calls this on every frame, so that is 72 ms per
 * second of playback or zero.
 */
export function clipAtTrack(clips: Clip[], t: number): ClipLocation | null {
  let start = 0
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]!
    start += clipOffset(clip)
    // **Both** bounds. Dropping the lower one was a real bug introduced by this
    // rewrite: with only `t < start + duration`, a position inside a gap matched
    // the clip *after* it, so silence decoded whatever followed it. Which is bug
    // #4 wearing a different hat — and the equivalence sweep in
    // test/positions.test.ts is what caught it, not a timing test.
    if (t >= start && t < start + clipDuration(clip)) return { clip, index: i, start }
    start += clipDuration(clip)
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
// the most common source of A/V drift (docs/export.md#av-sync).
// ---------------------------------------------------------------------------

export function toSampleIndex(seconds: number, sampleRate: number): number {
  return Math.round(seconds * sampleRate)
}

export function toFrameIndex(seconds: number, frameRate: number): number {
  return Math.round(seconds * frameRate)
}

/**
 * The furthest source time a clip may show.
 *
 * A still image has no inherent length: the probe gives it a default `duration`
 * so it has *some* length to be dropped in with, but its frame source serves a
 * frame for any timestamp, so it can be stretched as far as the timeline wants.
 * Treating that default as a hard media end is what stopped images from being
 * lengthened. Every other asset is bounded by its real source length.
 */
export function sourceLimit(asset: Asset | undefined): number {
  return asset && !asset.isImage ? asset.duration : Number.POSITIVE_INFINITY
}

export function clampClip(clip: Clip, asset: Asset): Clip {
  const limit = sourceLimit(asset)
  const inPoint = clamp(clip.in, 0, limit)
  const outPoint = clamp(clip.out, inPoint, limit)
  return outPoint > inPoint ? { ...clip, in: inPoint, out: outPoint } : { ...clip, in: inPoint, out: inPoint }
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

/** Find a clip by id in any track. */
export function findClip(project: Project, clipId: ClipId): { clip: Clip; trackId: TrackId; index: number } | null {
  for (const track of project.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId)
    if (index >= 0) return { clip: track.clips[index]!, trackId: track.id, index }
  }
  return null
}

/**
 * The other half of a linked pair, or null when the clip is unlinked.
 *
 * **The partner lives in a track of the opposite type, always.** The link exists
 * to pair picture with sound, so the answer can only be the clip of the same
 * `linkId` in an opposite-type track. Searching all tracks and returning the
 * first match in an opposite-type track is what makes this robust to a project
 * written by an older build.
 */
export function linkedPartner(project: Project, clip: Clip): Clip | null {
  if (!clip.linkId) return null
  const clipType = trackTypeById(project, clip.trackId)
  if (!clipType) return null
  const otherType: TrackType = clipType === 'video' ? 'audio' : 'video'
  for (const track of project.tracks) {
    if (track.type !== otherType) continue
    for (const other of track.clips) {
      if (other.linkId === clip.linkId) return other
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
    tracks: project.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((c) => (c.linkId === clip.linkId ? { ...c, linkId: undefined } : c)),
    })),
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
      ? [{ id: newId('clp'), trackId: 'video', assetId, in: 0, out: asset.duration, ...(linkId ? { linkId } : {}) }]
      : []
  const audio: Clip[] =
    asset.hasAudio
      ? [{ id: newId('clp'), trackId: 'audio', assetId, in: 0, out: asset.duration, ...(linkId ? { linkId } : {}) }]
      : []

  return {
    ...project,
    tracks: [
      { id: 'video', type: 'video', clips: video },
      { id: 'audio', type: 'audio', clips: audio },
    ],
  }
}

/**
 * Remove one clip. Linked partners survive — deleting is per-track.
 *
 * Deleting ripples the track closed, but only across a *touching* seam: the
 * clip that lands flush against the hole is pulled left into it, and the pull
 * carries on through the run of clips that were touching one another. It stops
 * at the first gap — that gap simply gets wider instead of the clips beyond it
 * sliding. So a clip that already had space before it never moves, and neither
 * does anything after it.
 *
 * Deleting the **first** clip never shifts anything. There is nothing before it
 * to ripple against, so moving the survivors would drag the whole track toward
 * zero for no reason the user asked for; the head is left empty and every
 * survivor keeps its absolute mark.
 */
export function removeClip(project: Project, trackId: TrackId, index: number): Project {
  const tracks = project.tracks.map((track) => {
    if (track.id !== trackId) return track
    const clips = track.clips
    const removed = clips[index]
    if (!removed) return track
    const survivors = clips.filter((_, i) => i !== index)
    if (survivors.length === 0) return { ...track, clips: survivors }

    const starts = clipStarts(clips)
    const right = clips[index + 1]
    // The pull only starts when the clip after the hole is flush against it.
    // `pull` is how far each survivor slides left; it drops to zero at the
    // first gap, so that gap absorbs the space instead of being crossed.
    let pull = index > 0 && right != null && clipOffset(right) === 0 ? clipDuration(removed) : 0
    const items: { clip: Clip; from: number }[] = []
    for (let i = 0; i < clips.length; i++) {
      if (i === index) continue
      const clip = clips[i]!
      if (pull > 0 && i > index && clipOffset(clip) > 0) pull = 0
      items.push({ clip, from: starts[i]! - (i > index ? pull : 0) })
    }
    return { ...track, clips: rederiveOffsets(items) }
  })
  return { ...project, tracks }
}

/**
 * Reorder. The moved clip lands flush against whatever is now before it.
 *
 * A gap is something you place deliberately; a reorder is a rearrangement, and
 * carrying an old offset into a new slot would leave an arbitrary hole. To
 * leave a gap, drag the clip — that is `placeClip`.
 */
export function moveClip(project: Project, trackId: TrackId, from: number, to: number): Project {
  const track = project.tracks.find((t) => t.id === trackId)
  if (!track) return project
  const clips = track.clips
  if (from === to || from < 0 || to < 0 || from >= clips.length || to >= clips.length) return project
  const next = clips.slice()
  const [clip] = next.splice(from, 1)
  next.splice(to, 0, { ...clip!, offset: 0 })
  return {
    ...project,
    tracks: project.tracks.map((t) => (t.id === trackId ? { ...t, clips: next } : t)),
  }
}

/**
 * Move a clip so it *starts* at `start`.
 *
 * **A move is local: this clip moves and nothing else does.** It is placed where
 * the pointer asks, clamped so it overlaps neither neighbour:
 *
 * - not before its predecessor (`prefix`);
 * - not past its successor, so it cannot overlap the clip in front of it.
 *
 * And the successor's own position is **pinned** by re-deriving its offset, so
 * moving this clip does not drag the one after it along. That pin is the whole
 * fix for the cut-piece complaint: positions are derived, so without it the clip
 * after the moved one slid with it — dragging the left half of a cut pulled the
 * right half, while dragging the right half (which has no successor) moved
 * alone.
 *
 * A negative offset would push the track before zero, and the target is the
 * clip's absolute start, so the prefix is subtracted once here — **not** its own
 * `clipStart`, which already includes the offset now and would turn the absolute
 * target into a half-speed increment.
 */
export function placeClip(project: Project, trackId: TrackId, index: number, start: number): Project {
  const tracks = project.tracks.map((track) => {
    if (track.id !== trackId) return track
    const clips = track.clips
    const clip = clips[index]
    if (!clip) return track

    const prefix = index === 0 ? 0 : clipEnd(clips, index - 1)
    const successor = clips[index + 1]
    // Where the clip after this one must stay. `clipStart(clips, index + 1)` is
    // its *current* absolute position; the moved clip may not reach past it.
    const successorStart = successor ? clipStart(clips, index + 1) : Number.POSITIVE_INFINITY
    const upper = successor ? successorStart - clipDuration(clip) : Number.POSITIVE_INFINITY
    // `Math.max(prefix, …)` on the upper bound too: a clip longer than the space
    // between its neighbours has no legal interior, and pinning the predecessor
    // beats a negative offset.
    const target = Math.min(Math.max(prefix, start), Math.max(prefix, upper))

    const next = clips.slice()
    next[index] = { ...clip, offset: target - prefix }
    if (successor) {
      // Hold the successor exactly where it is. Deriving its offset from the new
      // end of the moved clip is what keeps it still while this one travels.
      const gap = Math.max(0, successorStart - (target + clipDuration(clip)))
      next[index + 1] = { ...successor, offset: gap }
    }
    return { ...track, clips: next }
  })
  return { ...project, tracks }
}

/**
 * Move every selected clip by the same time delta.
 *
 * Group drag is a **rigid shift**, not a reorder: the selected clips keep their
 * order and their spacing, and each track is repacked around them. A selected
 * clip dragged left butts against its unselected predecessor rather than
 * crossing it; dragged right, it pushes the unselected clips after it along.
 *
 * **A group ripples; a single clip does not.** `placeClip` moves one clip
 * locally and pins the clip after it, so a single drag never drags a neighbour
 * along. A group is a different gesture — several clips moving as a block *do*
 * repack the track, because keeping the block together is the whole point.
 * Swapping past a neighbour is not offered at all any more.
 *
 * `anchorStart` is the desired timeline start of the clip under the pointer.
 * The delta is derived from that clip and then **clamped once, for the whole
 * selection**, before any track is repacked.
 *
 * The clamp is the part that makes the shift rigid rather than merely intended.
 * A leftward drag is limited, per track, by where that track's first selected clip
 * can but against its predecessor; those limits are different whenever one track
 * sits behind a gap. Clamping each track independently let the picture stop at
 * zero while its sound kept travelling — one gesture, two outcomes, and a linked
 * pair left permanently out of sync with no undo entry that says so. Taking the
 * *most constrained* track's limit and applying it to both keeps the block rigid:
 * it may stop short of the pointer, which is the honest cost of the promise.
 */
export function moveSelectionTo(
  project: Project,
  anchorTrackId: TrackId,
  anchorIndex: number,
  anchorStart: number,
  selected: ReadonlySet<ClipId>,
): Project {
  const anchorClips = trackById(project, anchorTrackId)
  if (!anchorClips[anchorIndex]) return project
  const desired = anchorStart - clipStart(anchorClips, anchorIndex)
  if (desired === 0) return project

  let delta = desired
  if (desired < 0) {
    // Leftward only: rightward has no wall to hit. For each track the binding
    // clip is the first selected one — everything before it is fixed, and the
    // selected clips after it keep their spacing. `floor - start` is how far
    // left that clip may go, so it is a lower bound on the delta.
    for (const track of project.tracks) {
      const clips = track.clips
      const first = clips.findIndex((clip) => selected.has(clip.id))
      if (first < 0) continue
      const floor = first === 0 ? 0 : clipEnd(clips, first - 1)
      const limit = floor - clipStart(clips, first)
      if (limit > delta) delta = limit
    }
  }

  return {
    ...project,
    tracks: project.tracks.map((track) => ({
      ...track,
      clips: shiftTrack(track.clips, selected, delta),
    })),
  }
}

/**
 * Drag the selection onto another track of the same kind.
 *
 * Every selected clip of the target's kind — wherever it currently sits — lands
 * on `targetTrackId` as one block, keeping its spacing, with the anchor clip's
 * start placed at `anchorStart`. This is what makes a montage: pull a piece of
 * one video up onto another video track and it *becomes* a clip of that layer.
 *
 * The target is repacked like any track — a clip lands where it was asked to be,
 * or at the end of its predecessor, whichever is later — so dropping onto an
 * occupied stretch pushes the target's later clips right and two clips never
 * overlap. Selected clips of the *other* kind (the sound half of a linked pair,
 * say) cannot join the target and instead shift by the same delta inside their
 * own tracks, so a linked pair stays in sync while its picture changes layer.
 */
export function moveClipsToTrack(
  project: Project,
  targetTrackId: TrackId,
  selected: ReadonlySet<ClipId>,
  anchorClipId: ClipId,
  anchorStart: number,
): Project {
  const target = project.tracks.find((t) => t.id === targetTrackId)
  if (!target) return project

  // Where each selected clip is now, in absolute time.
  const starts = new Map<ClipId, number>()
  for (const track of project.tracks) {
    let start = 0
    for (const clip of track.clips) {
      start += clipOffset(clip)
      if (selected.has(clip.id)) starts.set(clip.id, start)
      start += clipDuration(clip)
    }
  }
  const anchorNow = starts.get(anchorClipId)
  if (anchorNow === undefined) return project
  const delta = anchorStart - anchorNow

  // The target's future contents: its own fixed clips where they are, and the
  // movers at their shifted positions. Sorting by the desired start lets the
  // repack below resolve any overlap by pushing right, in timeline order.
  const placed: { clip: Clip; desired: number }[] = []
  for (const track of project.tracks) {
    if (track.type !== target.type) continue
    let start = 0
    for (const clip of track.clips) {
      start += clipOffset(clip)
      if (starts.has(clip.id)) {
        placed.push({ clip: { ...clip, trackId: targetTrackId }, desired: start + delta })
      } else if (track.id === targetTrackId) {
        placed.push({ clip, desired: start })
      }
      start += clipDuration(clip)
    }
  }
  placed.sort((a, b) => a.desired - b.desired)

  const clips: Clip[] = []
  let cursor = 0
  for (const { clip, desired } of placed) {
    const at = Math.max(cursor, desired)
    clips.push(clipOffset(clip) === at - cursor ? clip : { ...clip, offset: at - cursor })
    cursor = at + clipDuration(clip)
  }

  const tracks = project.tracks.map((track) => {
    if (track.id === targetTrackId) return { ...track, clips }
    if (track.type === target.type) {
      // Same kind but not the target: the movers have left. The clips that stay
      // keep their absolute positions — a hole is left where the mover was, so a
      // clip pulled up to another layer does not drag its successors left.
      const kept: Clip[] = []
      let original = 0
      let cursor = 0
      for (const clip of track.clips) {
        original += clipOffset(clip)
        if (!starts.has(clip.id)) {
          const offset = Math.max(0, original - cursor)
          kept.push(clipOffset(clip) === offset ? clip : { ...clip, offset })
          cursor = original + clipDuration(clip)
        }
        original += clipDuration(clip)
      }
      return kept.length === track.clips.length ? track : { ...track, clips: kept }
    }
    // The other kind: keep the linked half in sync by the same delta.
    return { ...track, clips: shiftTrack(track.clips, selected, delta) }
  })
  return { ...project, tracks }
}

/**
 * Repack one track with the selected clips shifted by `delta`.
 *
 * Each clip's desired position is its current one, plus `delta` when selected.
 * Walking left to right, a clip lands at its desired position or at the end of
 * its predecessor, whichever is later — so a leftward move is clamped by the
 * neighbour in front, and a rightward move pushes the one behind. `offset`
 * (silence before the clip) is re-derived from that, never stored as a position.
 */
function shiftTrack(clips: Clip[], selected: ReadonlySet<ClipId>, delta: number): Clip[] {
  if (!clips.some((clip) => selected.has(clip.id))) return clips
  const out: Clip[] = []
  // Running ends, not `clipStart` per index: the latter sums the track on every
  // call, which is O(n²) across a group drag and shows up on a long timeline.
  let originalEnd = 0
  let cursor = 0
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]!
    const originalStart = originalEnd + clipOffset(clip)
    const desired = originalStart + (selected.has(clip.id) ? delta : 0)
    const target = Math.max(cursor, desired)
    const offset = target - cursor
    // Reuse the clip when its own offset did not change. `<For>` keys on the
    // object reference, so handing it a fresh object for every clip remounts
    // the whole track — and each remount repaints that clip's filmstrip, which
    // made dragging a group of two heavy on a timeline of many.
    out.push(offset === clipOffset(clip) ? clip : { ...clip, offset })
    originalEnd = originalStart + clipDuration(clip)
    cursor = target + clipDuration(clip)
  }
  return out
}

/**
 * Which clips in a track move when the selection is dragged.
 *
 * The selected clips move by design, and so does every clip after the first
 * selected one — positions are derived (`clipStart`), so a clip dragged right
 * pushes its successors along. Their edges therefore travel with the drag, and
 * a snap target that travels with the drag is a target the clip chases: that is
 * the vibration. Only the clips *before* the first selected one are fixed.
 */
export function movingInTrack(clips: Clip[], selected: ReadonlySet<ClipId>): Set<ClipId> {
  const moving = new Set<ClipId>()
  let past = false
  for (const clip of clips) {
    if (selected.has(clip.id)) past = true
    if (past) moving.add(clip.id)
  }
  return moving
}

/**
 * How a drop behaves against whatever is already there.
 *
 * Both modes exist in every professional editor, and they answer different
 * questions: *insert* is "put this here and push the rest along", *overwrite* is
 * "put this here and lose what was here".
 *
 * `overwrite` is the default, because a drop onto occupied space that silently
 * shuffles everything along is the more surprising of the two — the user aimed
 * at a spot, not at a re-layout of their whole edit.
 */
export type DropMode = 'overwrite' | 'insert'

/** Index of the first clip starting at or after `time`, or the end of the track. */
function firstIndexAtOrAfter(clips: Clip[], time: number): number {
  // `clipStarts` once, rather than `clipStart` per index. This runs on every drop,
  // over a track that can be thousands of clips long.
  const starts = clipStarts(clips)
  for (let i = 0; i < starts.length; i++) {
    if (starts[i]! >= time - 1e-9) return i
  }
  return clips.length
}

/** Index of the clip covering `time`, or -1. */
function indexCovering(clips: Clip[], time: number): number {
  const starts = clipStarts(clips)
  for (let i = 0; i < starts.length; i++) {
    const end = starts[i]! + clipDuration(clips[i]!)
    if (time >= starts[i]! - 1e-9 && time < end - 1e-9) return i
  }
  return -1
}

/**
 * Split one clip at `time`, returning a new array.
 *
 * Null when the cut is too close to either end to produce two real clips — a
 * zero-length clip is a corrupt clip, not an edit.
 */
function splitOne(clips: Clip[], index: number, time: number): Clip[] | null {
  const clip = clips[index]!
  const local = time - clipStart(clips, index)
  if (local < MIN_CLIP || local > clipDuration(clip) - MIN_CLIP) return null

  const left: Clip = { ...clip, out: clip.in + local }
  const right: Clip = { ...clip, id: newId('clp'), in: clip.in + local, offset: 0 }
  return [...clips.slice(0, index), left, right, ...clips.slice(index + 1)]
}

/**
 * The nearest position to `time` where a cut can actually exist.
 *
 * A split is refused within `MIN_CLIP` of either end — `splitOne` refuses, and a
 * zero-length clip is what this file calls corrupt. The old answer to a drop that
 * landed there was to insert the clip *after* the one it landed on, which put it
 * at the far end of that clip: aim at 0.01s, get 10s, with nothing on screen to
 * explain it.
 *
 * Nudging the drop forward to the nearest legal cut is 40ms of movement, which is
 * invisible, and it is the edit the gesture actually meant. A clip shorter than
 * `2 × MIN_CLIP` has no legal interior at all, and `hi` collapses onto `lo` — the
 * split then fails as before and the caller falls back to inserting after.
 */
function nearestCuttable(clips: Clip[], index: number, time: number): number {
  const lo = clipStart(clips, index) + MIN_CLIP
  const hi = clipEnd(clips, index) - MIN_CLIP
  return Math.min(Math.max(time, lo), Math.max(lo, hi))
}

/**
 * Put `clip` on `trackId` starting at `time`, pushing later clips along.
 *
 * Works whether `time` is in a gap, inside a clip, or past the end — which is
 * the whole point. Dropping inside a clip splits it, so the material after the
 * drop point survives and simply moves down. That is what makes a drop
 * "land where you let go" instead of being quietly appended to the end.
 *
 * The inserted clip's position comes entirely from being *in the array* at the
 * right index, plus an `offset` for any gap the user aimed at. Nothing else is
 * stored, so nothing else can drift.
 */
export function insertClipAt(project: Project, trackId: TrackId, time: number, clip: Clip): Project {
  const tracks = project.tracks.map((track) => {
    if (track.id !== trackId) return track
    let clips = track.clips
    const covering = indexCovering(clips, time)

    // Two ways a drop can land, and both used to end up in the same wrong place —
    // the far end of the clip it was dropped on, with nothing on screen to explain
    // it. Aiming at 0.01s and getting 10s.
    //
    // **At a clip's start**, within MIN_CLIP. The user aimed *before* it, not a hair
    // inside it, and cutting there would split off a 40ms fragment of somebody's
    // footage — worse than useless. Treated as the boundary it is: the clip goes in
    // front, flush.
    //
    // **Mid-clip.** The cut still has to clear both ends, so it is nudged to the
    // nearest legal one: 40ms of movement, invisible, and the edit that was meant.
    let at: number
    let offset: number

    if (covering < 0) {
      at = firstIndexAtOrAfter(clips, time)
      offset = Math.max(0, time - (at === 0 ? 0 : clipEnd(clips, at - 1)))
    } else if (time - clipStart(clips, covering) < MIN_CLIP) {
      at = covering
      const floor = at === 0 ? 0 : clipEnd(clips, at - 1)
      offset = Math.max(floor, clipStart(clips, covering)) - floor
    } else {
      const cut = nearestCuttable(clips, covering, time)
      const halves = splitOne(clips, covering, cut)
      if (halves) {
        clips = halves
        at = covering + 1
        offset = Math.max(0, cut - clipEnd(clips, at - 1))
      } else {
        // A clip shorter than `2 × MIN_CLIP` has no legal interior at all, so there
        // is nothing to cut. In front of it still beats the far end of it.
        at = covering
        const floor = at === 0 ? 0 : clipEnd(clips, at - 1)
        offset = Math.max(floor, clipStart(clips, covering)) - floor
      }
    }

    const next = [...clips.slice(0, at), { ...clip, offset }, ...clips.slice(at)]
    return { ...track, clips: next }
  })
  return { ...project, tracks }
}

/**
 * What survives a cleared span, and the absolute time each should start at.
 *
 * Recorded as absolute times rather than offsets, because offsets are relative
 * to whatever ended before them — and an overwrite *changes* what ended before
 * them. Keeping the intent ("this clip starts at 6s") and re-deriving the
 * encoding afterwards is what makes the tail of a straddling clip stay put
 * instead of drifting.
 */
function survivorsInRange(clips: Clip[], start: number, end: number): { clip: Clip; from: number }[] {
  const EPS = 1e-6
  const survivors: { clip: Clip; from: number }[] = []
  const starts = clipStarts(clips)
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]!
    const s = starts[i]!
    const e = s + clipDuration(clip)

    // Six cases, and all six are needed. Treating "fully inside" as "straddles
    // the end" produced a clip with out < in — a zero-length clip, which the
    // model calls a corrupt clip, and which divides by zero somewhere later.
    if (e <= start + EPS || s >= end - EPS) {
      survivors.push({ clip, from: s }) // entirely outside
    } else if (s >= start - EPS && e <= end + EPS) {
      continue // entirely inside: gone, and that is the point of overwriting
    } else if (s < start && e > end) {
      // Straddles both edges: a head and a tail. The tail resumes at source
      // time `end - s`, so no footage is lost or repeated.
      survivors.push({ clip: { ...clip, out: clip.in + (start - s) }, from: s })
      survivors.push({ clip: { ...clip, id: newId('clp'), in: clip.in + (end - s) }, from: end })
    } else if (s < start) {
      survivors.push({ clip: { ...clip, out: clip.in + (start - s) }, from: s }) // head only
    } else {
      survivors.push({ clip: { ...clip, id: newId('clp'), in: clip.in + (end - s) }, from: end }) // tail only
    }
  }
  return survivors
}

/**
 * Turn desired absolute starts back into the model's derived encoding.
 *
 * `cursor` is the ABSOLUTE end of the previous survivor, so `from - cursor` is
 * this one's gap, and the cursor advances by `cursor + offset` — not by
 * `offset` alone, which would drift every later clip right by the total length
 * of everything before it.
 */
function rederiveOffsets(items: { clip: Clip; from: number }[]): Clip[] {
  const next: Clip[] = []
  let cursor = 0
  for (const { clip, from } of items) {
    const offset = Math.max(0, from - cursor)
    next.push({ ...clip, offset })
    cursor = cursor + offset + clipDuration(clip)
  }
  return next
}

/**
 * Remove everything between `start` and `end` from a track.
 *
 * A clip crossing either edge is *trimmed*, not deleted: clearing the middle of
 * a long clip leaves its head and its tail, which is not what "overwrite" means
 * if you read it as "delete". Gaps outside the span are kept, so the tail does
 * not slide left to fill the hole.
 */
export function clearTrackRange(project: Project, trackId: TrackId, start: number, end: number): Project {
  if (end <= start) return project
  const tracks = project.tracks.map((track) => {
    if (track.id !== trackId) return track
    const next = rederiveOffsets(survivorsInRange(track.clips, start, end))
    return { ...track, clips: next }
  })
  return { ...project, tracks }
}

/**
 * Place a clip at `time` on `trackId`: overwrite what is there, or push it along.
 *
 * The single entry point a drop should use, so "where does this go" has exactly
 * one answer in the codebase.
 *
 * The two modes are genuinely different operations, not one with a flag:
 *
 * - `insert` splices the clip into the array and leaves every later `offset`
 *   alone. Because position is derived, that *is* the push-along — everything
 *   after moves right by the inserted length, with no arithmetic at all.
 * - `overwrite` has to re-encode the track, because the clips after the drop are
 *   supposed to stay exactly where they were. It records the survivors' absolute
 *   starts, adds the new clip among them, and derives every offset in one pass
 *   at the end.
 */
export function placeClipAt(
  project: Project,
  trackId: TrackId,
  time: number,
  clip: Clip,
  mode: DropMode,
): Project {
  if (mode === 'insert') return insertClipAt(project, trackId, time, clip)

  const end = time + clipDuration(clip)
  const tracks = project.tracks.map((track) => {
    if (track.id !== trackId) return track
    const items = survivorsInRange(track.clips, time, end)
    // Put the new clip where it belongs among the survivors, keeping the list in
    // the order the timeline should read in.
    const at = items.findIndex((it) => it.from >= time - 1e-9)
    const withNew = [...items.slice(0, at < 0 ? items.length : at), { clip, from: time }, ...items.slice(at < 0 ? items.length : at)]
    return { ...track, clips: rederiveOffsets(withNew) }
  })
  return { ...project, tracks }
}

/**
 * Copy clips, placing each copy immediately after its original.
 *
 * A linked pair is copied *as a pair*: both halves get one fresh `linkId`, so
 * the duplicate can be split or trimmed without dragging the original along.
 * Giving each half its own id would silently break the link the moment anyone
 * touched the copy.
 *
 * Each half is placed against its own track, so a copy can overlap the clip
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

  // Walk each track front to back and insert directly after the source clip, so
  // later indices are never invalidated by an earlier insert.
  for (const track of project.tracks) {
    const source = track.clips
    const next: Clip[] = []
    // One pass for the whole track. This asked `clipStart` *and* `clipEnd` per
    // index, so duplicating on a long timeline was quadratic twice over.
    const starts = clipStarts(source)
    for (let index = 0; index < source.length; index += 1) {
      const clip = source[index]!
      next.push(clip)
      if (!ids.has(clip.id)) continue
      if (!out) out = { ...project, tracks: project.tracks.map((t) => ({ ...t, clips: t.clips.slice() })) }

      // The copy starts where the original ends.
      const start = starts[index]! + clipDuration(clip)
      const copy: Clip = {
        ...clip,
        id: newId('clp'),
        linkId: clip.linkId ? nextCopyId(clip) : undefined,
      }
      // Offset is relative to the end of whatever precedes the *copy*, which is
      // the original — and `start` was computed as the original's end, so the
      // difference is zero. Spelled out rather than written as `0` because the
      // subtraction is where the arithmetic is visible if that ever changes.
      next.push({ ...copy, offset: start - (starts[index]! + clipDuration(clip)) })
      copied += 1
    }
    if (out) {
      const outTrack = out.tracks.find((t) => t.id === track.id)!
      outTrack.clips = next
    }
  }

  return copied === 0 ? project : out!
}

/**
 * Minimum clip length. Below this, a clip divides by zero somewhere.
 *
 * Declared here rather than next to `splitLinked`, because it is a rule about
 * *every* write path, not about splitting: `splitOne`, `splitLinked` and
 * `survivorsInRange` each refuse to create a shorter clip, and `trimClip` has to
 * agree or a handle drag can produce what the rest of the file forbids.
 */
const MIN_CLIP = 0.04

export function trimClip(project: Project, trackId: TrackId, index: number, inPoint: number, outPoint: number): Project {
  const track = project.tracks.find((t) => t.id === trackId)
  if (!track) return project
  const clips = track.clips
  const clip = clips[index]
  if (!clip) return project
  const asset = project.assets[clip.assetId]
  const limit = sourceLimit(asset)
  let inClamped = clamp(inPoint, 0, limit)
  let outClamped = clamp(outPoint, inClamped, limit)

  // Never hand back a clip shorter than MIN_CLIP — not even the zero-length one
  // that dragging a handle past the far edge asks for. This is the only write
  // path that could produce one, and a zero-length clip is what
  // `survivorsInRange`'s own comment calls corrupt: it is skipped by
  // `clipAtTrack`, so the playhead can never land on it and it cannot be split,
  // yet it still sits in the array shifting everything after it.
  //
  // **Refused rather than clamped**, because which end the user is holding is
  // not an argument, and clamping both ends would move the one they are keeping
  // still. The visible result is identical anyway: every `pointermove` is its
  // own call, so the last accepted one is where the handle comes to rest.
  //
  // A clip that arrived from somewhere else already shorter than MIN_CLIP (an
  // overwrite can leave a sliver) can still be *grown* — only shrinking it
  // further is refused.
  if (outClamped - inClamped < MIN_CLIP) return project

  const starts = clipStarts(clips)
  const oldStart = starts[index]!
  const prefix = oldStart - clipOffset(clip)
  const oldEnd = oldStart + clipDuration(clip)

  // A trim **rolls** the clip: the edge being dragged moves, the other stays.
  // The in-point and the timeline start are two views of the same left edge, so
  // trimming `in` moves the start by the same amount — unless the clip would run
  // off the front of the lane or past its own source, in which case the start is
  // pinned and the in-point re-derived so the kept edge holds still.
  let newStart = oldStart + (inClamped - clip.in)
  const earliest = Math.max(prefix, oldStart - clip.in)
  if (newStart < earliest) {
    newStart = earliest
    inClamped = clip.out - (oldEnd - newStart)
  }
  const offset = newStart - prefix

  // A trim changes this clip's footprint but must **not** move its neighbour.
  // The clip after it keeps its absolute start: shortening leaves a wider gap,
  // lengthening eats into the gap, and a clip that would grow past its successor
  // stops at it. This is the same rule `placeClip` applies to a move; trimming
  // used to ripple every later clip along with it.
  const right = clips[index + 1]
  let rightOffset: number | null = null
  if (right) {
    const rightStart = starts[index + 1]!
    let newEnd = newStart + (outClamped - inClamped)
    if (newEnd > rightStart) {
      outClamped = inClamped + (rightStart - newStart)
      if (outClamped - inClamped < MIN_CLIP) return project
      newEnd = rightStart
    }
    rightOffset = rightStart - newEnd
  }

  const next = clips.slice()
  next[index] = { ...clip, in: inClamped, out: outClamped, offset }
  if (right && rightOffset !== null) next[index + 1] = { ...right, offset: rightOffset }
  return {
    ...project,
    tracks: project.tracks.map((t) => (t.id === trackId ? { ...t, clips: next } : t)),
  }
}

/**
 * Split **one clip in one track**, leaving its link partner whole.
 *
 * This is the gesture "cut the picture and keep the sound" (or the reverse):
 * the user selected one side of a linked pair, so only that side is cut. The
 * left half keeps the original `linkId` because it still starts where the
 * untouched partner starts; the right half is made **unlinked** (its own fresh
 * id would be a group of one), so it cannot be mistaken for the partner of a
 * clip the user never cut.
 *
 * `splitLinked` is the "cut both halves" version and is used when the pair is
 * selected together, or when nothing is selected and both tracks are cut.
 */
export function splitClip(project: Project, trackId: TrackId, index: number, timelineT: number): Project {
  let split = false
  const tracks = project.tracks.map((track) => {
    if (track.id !== trackId) return track
    const clips = track.clips
    const clip = clips[index]
    if (!clip) return track

    const local = timelineT - clipStart(clips, index)
    if (local < MIN_CLIP || local > clipDuration(clip) - MIN_CLIP) return track

    const left: Clip = { ...clip, out: clip.in + local }
    const right: Clip = { ...clip, id: newId('clp'), in: clip.in + local, offset: 0, linkId: undefined }
    split = true
    return { ...track, clips: [...clips.slice(0, index), left, right, ...clips.slice(index + 1)] }
  })
  // Return the SAME project when nothing split, so callers that detect a no-op by
  // identity (see `splitCore` in edits.ts) record no history for a refused cut.
  if (!split) return project
  return { ...project, tracks }
}

/**
 * Split a clip at a timeline position, and its linked partner along with it.
 *
 * Each half is split against *its own* start and in-point. A linked pair can
 * legitimately be out of alignment — you may have slid the audio — and
 * splitting the audio at the video's source time would land in the wrong
 * place.
 */
export function splitLinked(project: Project, trackId: TrackId, index: number, timelineT: number): Project {
  let next = project
  const track = project.tracks.find((t) => t.id === trackId)
  if (!track) return project
  const clips = track.clips
  const clip = clips[index]
  if (!clip) return project

  const local = timelineT - clipStart(clips, index)
  if (local < MIN_CLIP || local > clipDuration(clip) - MIN_CLIP) return project

  // The right halves become a new link group, so each side stays a pair.
  //
  // Keeping the original `linkId` on both halves made *four* clips share one id,
  // and since `linkedPartner` then had no way to tell one pair from the other, a
  // second split resolved the partner to its own same-track left half. The result
  // was that the audio half was never cut again, "Split selection" reported
  // nothing to split, and "Trim selection" trimmed only the video. The left
  // halves keep the original id, so they remain paired; the right halves get one
  // fresh id between them, exactly as `duplicateClips` already does for a copy.
  const rightLink = clip.linkId ? newId('lnk') : undefined
  const left: Clip = { ...clip, out: clip.in + local }
  // The right half starts where the left ends, so it carries no offset — its
  // position comes from being next in the array.
  const right: Clip = { ...clip, id: newId('clp'), in: clip.in + local, offset: 0, linkId: rightLink }

  next = {
    ...next,
    tracks: next.tracks.map((t) =>
      t.id === trackId ? { ...t, clips: [...clips.slice(0, index), left, right, ...clips.slice(index + 1)] } : t,
    ),
  }

  const partner = linkedPartner(project, clip)
  if (partner) {
    const partnerTrack = next.tracks.find((t) => t.id === partner.trackId)
    if (partnerTrack) {
      const otherClips = partnerTrack.clips
      const partnerIndex = otherClips.findIndex((c) => c.id === partner.id)
      if (partnerIndex >= 0) {
        const partnerLocal = timelineT - clipStart(otherClips, partnerIndex)
        const p = otherClips[partnerIndex]!
        // Respect the same minimum on the partner: a split that is valid for
        // video but produces a 10 ms audio clip is not a split anyone wanted.
        if (partnerLocal >= MIN_CLIP && partnerLocal <= clipDuration(p) - MIN_CLIP) {
          const pLeft: Clip = { ...p, out: p.in + partnerLocal }
          const pRight: Clip = { ...p, id: newId('clp'), in: p.in + partnerLocal, offset: 0, linkId: rightLink }
          const other = [...otherClips.slice(0, partnerIndex), pLeft, pRight, ...otherClips.slice(partnerIndex + 1)]
          next = {
            ...next,
            tracks: next.tracks.map((t) => (t.id === partnerTrack.id ? { ...t, clips: other } : t)),
          }
        }
      }
    }
  }

  return next
}

export function setTransform(project: Project, clipId: ClipId, transform: ClipTransform): Project {
  const found = findClip(project, clipId)
  if (!found) return project
  const tracks = project.tracks.map((track) => {
    if (track.id !== found.trackId) return track
    const next = track.clips.slice()
    next[found.index] = { ...next[found.index]!, transform }
    return { ...track, clips: next }
  })
  return { ...project, tracks }
}

export function setClipGain(project: Project, clipId: ClipId, gain: number): Project {
  const found = findClip(project, clipId)
  if (!found) return project
  const tracks = project.tracks.map((track) => {
    if (track.id !== found.trackId) return track
    const next = track.clips.slice()
    next[found.index] = { ...next[found.index]!, gain: clamp(gain, 0, 2) }
    return { ...track, clips: next }
  })
  return { ...project, tracks }
}

/**
 * Mute or unmute a clip.
 *
 * **Audio track only.** A video clip has nothing to mute, and letting one carry
 * a `muted` flag is worse than a no-op: the flag shows up in the UI as a mute
 * badge on a clip with no sound, and it silently changes the audio mixer's
 * gain for a clip that was never in it. Refusing here means no caller can
 * produce that state, rather than relying on each one to remember the rule.
 */
export function toggleMute(project: Project, clipId: ClipId): Project {
  const found = findClip(project, clipId)
  if (!found) return project
  const trackType = trackTypeById(project, found.trackId)
  if (trackType !== 'audio') return project
  const tracks = project.tracks.map((track) => {
    if (track.id !== found.trackId) return track
    const next = track.clips.slice()
    next[found.index] = { ...next[found.index]!, muted: !next[found.index]!.muted }
    return { ...track, clips: next }
  })
  return { ...project, tracks }
}

/**
 * Hide or show a clip: black picture, sound untouched.
 *
 * **Video track only**, for the same reason `toggleMute` is audio-only. What it
 * costs to be lax here is higher, though: a `hidden` flag that reached the
 * exporter would write a black run into somebody's file.
 *
 * Hiding is *not* removing. The clip keeps its place in the timeline, its link,
 * and its audio, and showing it again brings the picture straight back — which
 * is why this is not `delete`, and why the flag lives on the clip rather than
 * being remembered as a separate list.
 */
export function toggleHidden(project: Project, clipId: ClipId): Project {
  const found = findClip(project, clipId)
  if (!found) return project
  const trackType = trackTypeById(project, found.trackId)
  if (trackType !== 'video') return project
  const tracks = project.tracks.map((track) => {
    if (track.id !== found.trackId) return track
    const next = track.clips.slice()
    next[found.index] = { ...next[found.index]!, hidden: !next[found.index]!.hidden }
    return { ...track, clips: next }
  })
  return { ...project, tracks }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

export function emptyProject(): Project {
  return {
    version: 3,
    assets: {},
    tracks: [
      { id: 'video', type: 'video', clips: [] },
      { id: 'audio', type: 'audio', clips: [] },
    ],
  }
}

/**
 * Load with a hand-written guard rather than pulling in a schema library.
 * A malformed project must produce a clear error, never a half-built world.
 */
export function parseProject(text: string): Project {
  const data: unknown = JSON.parse(text)
  if (typeof data !== 'object' || data === null) throw new Error('Project is not an object')
  const p = data as Partial<Project>

  if (p.version !== 3) {
    throw new Error(
      p.version === 2
        ? 'This project was saved before the multi-track format and cannot be opened.'
        : `Unsupported project version: ${String(p.version)}`,
    )
  }
  if (typeof p.assets !== 'object' || p.assets === null) throw new Error('Project has no assets map')
  if (!Array.isArray(p.tracks)) throw new Error('Project must have a tracks array')

  for (const track of p.tracks) {
    if (typeof track.id !== 'string') throw new Error('A track is missing its id')
    if (track.type !== 'video' && track.type !== 'audio') throw new Error(`Track ${track.id} has invalid type`)
    if (!Array.isArray(track.clips)) throw new Error(`Track ${track.id} has no clips array`)
    for (const clip of track.clips) {
      if (typeof clip.id !== 'string') throw new Error(`A clip in track ${track.id} is missing its id`)
      if (typeof clip.trackId !== 'string') throw new Error(`Clip ${clip.id} missing trackId`)
      if (typeof clip.assetId !== 'string') throw new Error(`Clip ${clip.id} missing assetId`)
      if (typeof clip.in !== 'number' || typeof clip.out !== 'number') {
        throw new Error(`Clip ${clip.id} has non-numeric in/out`)
      }
    }
  }

  return {
    version: 3,
    assets: p.assets,
    tracks: p.tracks,
    ...(p.captions ? { captions: p.captions } : {}),
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}
