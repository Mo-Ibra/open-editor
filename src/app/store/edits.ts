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

import { AudioEngine } from '../../audio/audio-engine.js'
import {
  breakLink,
  clipAtLane,
  clipEnd,
  clipStart,
  duplicateClips,
  findClip,
  laneOf,
  moveClip,
  moveSelectionTo,
  placeClip,
  removeClip,
  setClipGain as applyGain,
  setTransform as applyTransform,
  sourceTimeAt,
  splitClip,
  splitLinked,
  toggleMute as applyMute,
  toggleHidden as applyHidden,
  trimClip as applyTrim,
  type Clip,
  type ClipId,
  type Lane,
  type Project,
} from '../../model/project.js'
import type { Lanes } from '../../model/project-store.js'
import type { History } from './history.js'
import type { Selection } from './selection.js'

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
  /** Move the whole selection as one block, anchored on `index`. */
  moveSelection: (lane: Lane, index: number, start: number) => void
  trim: (lane: Lane, index: number, inPoint: number, outPoint: number) => void
  setTransform: (clipId: ClipId, transform: Clip['transform']) => void
  setClipGain: (clipId: ClipId, gain: number) => void
  toggleMuteSelected: () => void
  toggleMute: (clipId: ClipId) => void
  /** Mute audio clips, hide video clips. */
  toggleHideSelected: () => void
  /** Hide or show every selected video clip, leaving audio clips alone. */
  toggleHiddenSelected: () => void
  toggleHidden: (clipId: ClipId) => void
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

/**
 * Split the clip under the playhead.
 *
 * **Which lanes are cut is the user's choice, expressed by the selection.**
 * A selection names the lanes it wants touched:
 *
 * - nothing selected → both lanes;
 * - only video selected → the picture, and the sound is left whole;
 * - only audio selected → the sound, and the picture is left whole;
 * - both lanes selected → both.
 *
 * Within a chosen lane the clip under the playhead is cut. That is also why `S`
 * used to "sometimes not work": it was tied to the *selected clip* rather than
 * the selected lane, so a playhead parked over a different clip in the same lane
 * found nothing to cut. The playhead is the cut point; the selection only says
 * which lanes care.
 *
 * A pair selected together (or the no-selection case) is cut with
 * `splitLinked`, so the two right halves stay linked. A single lane is cut with
 * `splitClip`, which leaves the other lane's clip untouched. Both model
 * functions return the very same project when the cut is refused, so identity is
 * the honest no-op test — the one `duplicateClips` relies on.
 */
function splitCore(time: number, lane?: Lane): { next: Project; split: number } {
  const before = unwrap(project)
  let next = before
  let split = 0

  /** Cut only `l`'s clip, leaving the other lane — and any link — alone. */
  const cutOnly = (l: Lane): void => {
    const loc = clipAtLane(next[l], time)
    if (!loc) return
    const after = splitClip(next, l, loc.index, time)
    if (after === next) return
    next = after
    split += 1
  }

  /** Cut `l`'s clip and its linked partner, so a pair stays a pair. */
  const cutPair = (l: Lane): void => {
    const loc = clipAtLane(next[l], time)
    if (!loc) return
    const after = splitLinked(next, l, loc.index, time)
    if (after === next) return
    next = after
    split += 1
  }

  if (lane) {
    cutOnly(lane)
  } else {
    const selected = sel.clips()
    const lanes = new Set(selected.map((c) => c.lane))
    if (lanes.size === 1) {
      // Exactly one lane is selected: that lane alone is cut.
      cutOnly(selected[0]!.lane)
    } else {
      // Nothing selected, both lanes selected, or a stale selection: cut both.
      cutPair('video')
      cutPair('audio')
    }
  }

  return { next, split }
}

function splitAt(time: number, lane?: Lane): void {
  const { next, split } = splitCore(time, lane)
  if (split === 0) {
    // Say so rather than doing nothing silently. A playhead that snapped onto a
    // clip edge, or into a gap, makes `S` look broken; naming the reason is what
    // separates "the app is ignoring me" from "there is no cut there".
    notify('info', 'Nothing to split — put the playhead inside a clip.')
    return
  }
  history.commit()
  setProject(replace(next))
}

/** The same cut, with a word to the user about whether it happened. */
function splitSelectionAtPlayhead(): void {
  const { next, split } = splitCore(playhead())
  if (split === 0) {
    notify('info', 'Nothing to split — put the playhead inside a clip.')
    return
  }
  history.commit()
  setProject(replace(next))
  notify('info', `Split ${split} clip${split === 1 ? '' : 's'}.`)
}

/**
 * Trim each selected clip's nearest edge to the playhead.
 *
 * **No link dedupe here, and that is the fix.** `splitSelectionAtPlayhead`
 * dedupes by `linkId` because `splitLinked` cuts both halves of a pair, so
 * counting both would cut the second one twice. `trim` does *not* touch the
 * partner, so copying the dedupe over silently dropped the audio half: selecting
 * a linked pair and trimming trimmed only the picture. Each selected clip takes
 * its own nearest edge, which is what the sentence above has always claimed.
 */
function trimSelectionToPlayhead(): void {
  const t = playhead()
  const clips = sel.clips()
  if (clips.length === 0) return

  const targets = clips
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

// No `history.commit()` here (or in `place`/`trim`): these run many times per
// drag gesture, and the drag controller records the gesture once, at its first
// movement. Committing per call made one drag fill the undo stack, and leaving
// it out entirely made undo skip past the drag.
function reorder(lane: Lane, from: number, to: number): void {
  if (from === to) return
  setProject(replace(moveClip(unwrap(project), lane, from, to)))
}

/**
 * Move a clip so it starts at `start`, leaving a gap if it moves right.
 * Clamped so a clip can never overlap the one before it.
 */
function place(lane: Lane, index: number, start: number): void {
  setProject(replace(placeClip(unwrap(project), lane, index, start)))
}

/**
 * Drag a multi-selection as a rigid block.
 *
 * The anchor is the clip under the pointer; `start` is where it should land.
 * Every selected clip follows by the same delta, in both lanes, so a linked
 * pair stays together without a special case.
 */
function moveSelection(lane: Lane, index: number, start: number): void {
  const ids = sel.ids()
  if (ids.length < 2) return
  setProject(replace(moveSelectionTo(unwrap(project), lane, index, start, new Set(ids))))
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

/**
 * Mute or hide every selected clip, by lane.
 *
 * One action, two meanings, because that is how it reads: a selected video clip
 * has nothing to mute, and a selected audio clip has nothing to hide. Routing by
 * lane means the user does not have to know which flag a given lane uses — they
 * press the key and the clip goes quiet or black.
 *
 * A mixed selection gets both, which is the honest answer to "I selected a
 * linked pair and want the picture hidden but the sound kept".
 */
function toggleHideSelected(): void {
  const clips = sel.clips()
  if (clips.length === 0) return
  const audible = clips.filter((c) => c.lane === 'audio')
  const video = clips.filter((c) => c.lane === 'video')
  if (audible.length === 0 && video.length === 0) return

  // One keypress should *mute* (or hide) the selection, not flip each clip
  // independently — otherwise a half-muted selection stays half-muted forever.
  const shouldHide = [...audible, ...video].some((c) => !(c.lane === 'audio' ? c.muted : c.hidden))
  let changed = 0

  for (const clip of audible) {
    if (Boolean(clip.muted) === shouldHide) continue
    setProject(replace(applyMute(unwrap(project), clip.id)))
    const found = findClip(project, clip.id)
    if (found) audio.setClipGain(found.clip)
    changed++
  }
  for (const clip of video) {
    if (Boolean(clip.hidden) === shouldHide) continue
    setProject(replace(applyHidden(unwrap(project), clip.id)))
    changed++
  }

  if (changed === 0) return
  // Name the action in the words the user used. An audio clip announces
  // "Muted", a video clip "Hidden" — announcing "Hidden 1 clip (sound)" reads
  // like the app is hiding an audio track, which is not a thing it does.
  const parts: string[] = []
  if (audible.length > 0) parts.push(shouldHide ? 'muted' : 'unmuted')
  if (video.length > 0) parts.push(shouldHide ? 'hidden' : 'shown')
  const noun = audible.length > 0 && video.length > 0 ? 'clips' : 'clip'
  notify('info', `${parts.join(' and ')} ${changed} ${noun}${changed === 1 ? '' : 's'}.`)
}

/**
 * Hide or show every selected video clip, leaving audio clips alone.
 *
 * The lane-specific twin of `toggleMuteSelected`, so the context menu can offer
 * "Hide picture" and "Mute sound" as two honest rows rather than one combined
 * action whose label depends on what happened to be selected.
 */
function toggleHiddenSelected(): void {
  const clips = sel.clips().filter((c) => c.lane === 'video')
  if (clips.length === 0) return
  // Hide all if any is currently visible, so one press hides the selection
  // rather than flipping each clip independently.
  const shouldHide = clips.some((c) => !c.hidden)
  for (const clip of clips) {
    if (Boolean(clip.hidden) === shouldHide) continue
    setProject(replace(applyHidden(unwrap(project), clip.id)))
  }
  notify('info', `${shouldHide ? 'Hid' : 'Showed'} ${clips.length} clip${clips.length === 1 ? '' : 's'}.`)
}

/** Hide or show one clip, by lane. */
function toggleHidden(clipId: ClipId): void {
  const before = findClip(project, clipId)
  if (!before) return
  setProject(replace(
    before.lane === 'audio' ? applyMute(unwrap(project), clipId) : applyHidden(unwrap(project), clipId),
  ))
  if (before.lane === 'audio') {
    const found = findClip(project, clipId)
    if (found) audio.setClipGain(found.clip)
  }
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
    moveSelection,
    trim,
    setTransform,
    setClipGain,
    toggleMuteSelected,
    toggleMute,
    toggleHideSelected,
    toggleHiddenSelected,
    toggleHidden,
    breakSelectedLinks,
    selectionHasLinks,
    replace,
  }
}
