/**
 * Clip edits.
 *
 * Every function here is a thin wrapper: it commits history, translates a user
 * gesture into a call on `model/project.ts`, and writes the result back. The
 * actual semantics — what a split does to a linked pair, where a gap sits, why
 * a video clip cannot be muted — live in the model, where they are pure and
 * tested without a browser.
 *
 * That split is the point. This file decides *intent* (commit first, select
 * afterwards, tell the user what happened); the model decides *meaning*.
 */

import { unwrap } from 'solid-js/store'

import { AudioEngine } from '../audio/audio-engine.js'
import {
  breakLink,
  clipAtLane,
  clipEnd,
  clipStart,
  duplicateClips,
  findClip,
  laneOf,
  moveClip,
  placeClip,
  removeClip,
  setClipGain as applyGain,
  setTransform as applyTransform,
  sourceTimeAt,
  splitLinked,
  toggleMute as applyMute,
  trimClip as applyTrim,
  type Clip,
  type ClipId,
  type Lane,
  type Project,
} from '../model/project.js'
import type { Lanes } from '../model/project-store.js'
import type { History } from './history.js'
import type { Selection } from './selection.js'

/**
 * The shortest clip a split will leave behind, in seconds.
 *
 * A split exactly on an edge would create a zero-length clip, which breaks
 * every downstream assumption about a clip having duration.
 */
const MIN_SPLIT = 0.01

export interface EditDeps {
  project: Project
  history: History
  selection: Selection
  audio: AudioEngine
  notify: (kind: 'info' | 'warn' | 'error', text: string) => void
  /** The only way the timeline changes. Never `reconcile` — see project-store. */
  setLanes: (video: Clip[], audio: Clip[]) => void
  playhead: () => number
}

export interface EditSlice {
  splitAt: (time: number, lane?: Lane) => void
  splitSelectionAtPlayhead: () => void
  trimSelectionToPlayhead: () => void
  deleteSelected: () => void
  trimToPlayhead: (clipId: ClipId) => void
  clearLane: (lane: Lane) => void
  duplicateSelected: () => void
  reorder: (lane: Lane, from: number, to: number) => void
  place: (lane: Lane, index: number, start: number) => void
  trim: (lane: Lane, index: number, inPoint: number, outPoint: number) => void
  setTransform: (clipId: ClipId, transform: Clip['transform']) => void
  setClipGain: (clipId: ClipId, gain: number) => void
  toggleMuteSelected: () => void
  toggleMute: (clipId: ClipId) => void
  breakSelectedLinks: () => void
  selectionHasLinks: () => boolean
  /** Derive the lanes from a whole Project, for the terser call sites. */
  replace: (next: Project) => Lanes
}

export function createEdits(deps: EditDeps): EditSlice {
  const { project, history, selection: sel, audio, notify, setLanes, playhead } = deps

  /** Keep `setProject(next)` readable at every call site. */
  const replace = (next: Project): Lanes => ({ video: next.video, audio: next.audio })
  const setProject = (lanes: Lanes): void => setLanes(lanes.video, lanes.audio)

function splitAt(time: number, lane?: Lane): void {
  history.commit()

  if (lane) {
    const loc = clipAtLane(laneOf(project, lane), time)
    if (!loc) return
    setProject(replace(splitLinked(unwrap(project), lane, loc.index, time)))
    return
  }

  const anchor = sel.primary()
  if (anchor) {
    const found = findClip(project, anchor)
    if (found) {
      setProject(replace(splitLinked(unwrap(project), found.lane, found.index, time)))
      return
    }
  }

  // Nothing selected: split each lane independently at the playhead.
  let next = unwrap(project)
  for (const l of ['video', 'audio'] as const) {
    const loc = clipAtLane(next[l], time)
    if (loc) next = splitLinked(next, l, loc.index, time)
  }
  setProject(replace(next))
}

/**
 * Split every selected clip at the playhead.
 *
 * Two details make this more than a loop over `splitAt`:
 *
 * - A linked pair is split by `splitLinked`, which cuts *both* halves. So a
 *   selected pair must be counted once, or the second call would try to split
 *   a clip that no longer exists there.
 * - A clip whose edge is already at the playhead is skipped. Splitting there
 *   produces a zero-length clip, which is a corrupt clip, not an edit.
 *
 * Back-to-front per lane, because each split inserts a clip and shifts every
 * later index down.
 */
function splitSelectionAtPlayhead(): void {
  const t = playhead()
  const clips = sel.clips()
  if (clips.length === 0) return

  // One entry per link group, so a selected pair splits once.
  const seen = new Set<string>()
  const targets = clips
    .filter((c) => {
      const key = c.linkId ?? c.id
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map((c) => findClip(project, c.id)!)
    .filter(Boolean)
    .sort((a, b) => b.lane.localeCompare(a.lane) || b.index - a.index)

  let next = unwrap(project)
  let split = 0
  for (const { lane, index } of targets) {
    const laneClips = next[lane]
    const start = clipStart(laneClips, index)
    const end = clipEnd(laneClips, index)
    if (t <= start + MIN_SPLIT || t >= end - MIN_SPLIT) continue
    next = splitLinked(next, lane, index, t)
    split += 1
  }
  if (split === 0) {
    notify('info', 'Nothing to split — put the playhead inside a selected clip.')
    return
  }
  history.commit()
  setProject(replace(next))
  notify('info', `Split ${split} clip${split === 1 ? '' : 's'}.`)
}

/** Trim each selected clip's nearest edge to the playhead. */
function trimSelectionToPlayhead(): void {
  const t = playhead()
  const clips = sel.clips()
  if (clips.length === 0) return

  const seen = new Set<string>()
  const targets = clips
    .filter((c) => {
      const key = c.linkId ?? c.id
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map((c) => findClip(project, c.id)!)
    .filter(Boolean)

  const usable = targets.filter(({ lane, index }) => {
    const laneClips = laneOf(project, lane)
    return clipStart(laneClips, index) < t && t < clipEnd(laneClips, index)
  })
  if (usable.length === 0) {
    notify('info', 'Move the playhead inside a selected clip to trim it.')
    return
  }

  history.commit()
  for (const { clip, lane, index } of usable) {
    const laneClips = laneOf(project, lane)
    const loc = { clip, lane, clips: laneClips, index, start: clipStart(laneClips, index) }
    const at = sourceTimeAt(loc as never, t)
    // The nearer edge is the one the playhead is closest to.
    if (t - clipStart(laneClips, index) < clipEnd(laneClips, index) - t) {
      trim(lane, index, at, clip.out)
    } else {
      trim(lane, index, clip.in, at)
    }
  }
}

/**
 * Delete every selected clip.
 *
 * Only the selected clips — deleting a whole lane is a separate, deliberate
 * act. That separation is the point of having lanes: cutting the picture
 * while keeping the sound is a normal thing to want, so "delete" must never
 * quietly mean "delete the pair".
 */
function deleteSelected(): void {
  const clips = sel.clips()
  if (clips.length === 0) return
  history.commit()
  // Highest index first per lane: removing a clip shifts every later index
  // down, so working backwards means no index is ever stale.
  const doomed = clips
    .map((clip) => findClip(project, clip.id)!)
    .filter(Boolean)
    .sort((a, b) => b.lane.localeCompare(a.lane) || b.index - a.index)
  for (const { lane, index } of doomed) {
    setProject(replace(removeClip(unwrap(project), lane, index)))
  }
  sel.clear()
  notify('info', clips.length === 1 ? 'Deleted clip.' : `Deleted ${clips.length} clips.`)
}

/** Trim a clip's edge to the playhead. */
function trimToPlayhead(clipId: ClipId): void {
  const found = findClip(project, clipId)
  if (!found) return
  const loc = clipAtLane(laneOf(project, found.lane), playhead())
  if (!loc || loc.clip.id !== clipId) {
    notify('info', 'Move the playhead over the clip first.')
    return
  }
  const at = sourceTimeAt(loc, playhead())
  if (at > found.clip.out) trim(found.lane, found.index, found.clip.in, at)
  else trim(found.lane, found.index, at, found.clip.out)
}

/** Empty one lane, leaving the other untouched — a linked pair is broken
 *  by this, which is the honest outcome of deleting only half. */
function clearLane(lane: Lane): void {
  if (laneOf(project, lane).length === 0) return
  history.commit()
  setLanes(lane === 'video' ? [] : unwrap(project).video, lane === 'audio' ? [] : unwrap(project).audio)
  // A selected clip on the cleared lane cannot stay selected.
  sel.replaceAll(sel.ids().filter((id) => findClip(project, id)?.lane !== lane))
  notify('info', `Cleared the ${lane} lane.`)
}

/**
 * Copy every selected clip, and select the copies.
 *
 * Selecting the copies rather than the originals is what makes a second
 * ctrl+D repeat the operation instead of piling up copies of the first pair.
 */
function duplicateSelected(): void {
  const clips = sel.clips()
  if (clips.length === 0) return
  history.commit()
  const next = duplicateClips(unwrap(project), clips.map((c) => c.id))
  // The copies are the ones after each original, in the same lane order.
  const copies: ClipId[] = []
  for (const lane of ['video', 'audio'] as const) {
    const wanted = new Set(clips.filter((c) => c.lane === lane).map((c) => c.id))
    const laneClips = next[lane]
    for (let i = 0; i < laneClips.length; i += 1) {
      // A copy sits immediately after its original, so anything at an odd
      // position following a wanted clip is a copy of it.
      if (i > 0 && wanted.has(laneClips[i - 1]!.id)) copies.push(laneClips[i]!.id)
    }
  }
  setLanes(next.video, next.audio)
  sel.replaceAll(copies)
  notify('info', copies.length === 1 ? 'Duplicated clip.' : `Duplicated ${copies.length} clips.`)
}

function reorder(lane: Lane, from: number, to: number): void {
  if (from === to) return
  history.commit()
  setProject(replace(moveClip(unwrap(project), lane, from, to)))
}

/**
 * Move a clip so it starts at `start`, leaving a gap if it moves right.
 * Clamped so a clip can never overlap the one before it.
 */
function place(lane: Lane, index: number, start: number): void {
  setProject(replace(placeClip(unwrap(project), lane, index, start)))
}

function trim(lane: Lane, index: number, inPoint: number, outPoint: number): void {
  setProject(replace(applyTrim(unwrap(project), lane, index, inPoint, outPoint)))
}

function setTransform(clipId: ClipId, transform: Clip['transform']): void {
  setProject(replace(applyTransform(unwrap(project), clipId, transform!)))
}

function setClipGain(clipId: ClipId, gain: number): void {
  setProject(replace(applyGain(unwrap(project), clipId, gain)))
  const found = findClip(project, clipId)
  if (found) audio.setClipGain(found.clip)
}

/** Mute or unmute every selected audio clip, leaving video clips alone. */
function toggleMuteSelected(): void {
  const clips = sel.clips().filter((c) => c.lane === 'audio')
  if (clips.length === 0) return
  // Mute all if any of them is currently audible, so one keypress mutes the
  // selection rather than flipping each clip independently.
  const shouldMute = clips.some((c) => !c.muted)
  for (const clip of clips) {
    if (Boolean(clip.muted) === shouldMute) continue
    setProject(replace(applyMute(unwrap(project), clip.id)))
    const found = findClip(project, clip.id)
    if (found) audio.setClipGain(found.clip)
  }
  notify('info', `${shouldMute ? 'Muted' : 'Unmuted'} ${clips.length} clip${clips.length === 1 ? '' : 's'}.`)
}

function toggleMute(clipId: ClipId): void {
  setProject(replace(applyMute(unwrap(project), clipId)))
  const found = findClip(project, clipId)
  if (found) audio.setClipGain(found.clip)
}

/**
 * Break the link on every selected linked clip, so each pair becomes
 * independent. Unlinked clips are skipped rather than being an error: a
 * mixed selection is normal once ctrl-click is in play.
 */
function breakSelectedLinks(): void {
  const linked = sel.clips().filter((c) => c.linkId)
  if (linked.length === 0) return
  history.commit()
  for (const clip of linked) setProject(replace(breakLink(unwrap(project), clip)))
  notify('info', `Unlinked ${linked.length} clip${linked.length === 1 ? '' : 's'}.`)
}

const selectionHasLinks = (): boolean => sel.clips().some((c) => Boolean(c.linkId))

  return {
    splitAt,
    splitSelectionAtPlayhead,
    trimSelectionToPlayhead,
    deleteSelected,
    trimToPlayhead,
    clearLane,
    duplicateSelected,
    reorder,
    place,
    trim,
    setTransform,
    setClipGain,
    toggleMuteSelected,
    toggleMute,
    breakSelectedLinks,
    selectionHasLinks,
    replace,
  }
}
