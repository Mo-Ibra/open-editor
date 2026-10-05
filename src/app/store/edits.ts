/**
 * Clip edits.
 *
 * Every function here is a thin wrapper: it commits history, translates a user
 * gesture into a call on `model/project.ts`, and writes the result back. The
 * actual semantics — what a split does to a linked pair, where a gap sits, why
 * a video clip cannot be muted — live in the model, where they are pure and
 * tested without a browser.
 */

import { unwrap } from 'solid-js/store'

import { AudioEngine } from '../../audio/audio-engine.js'
import {
  breakLink,
  clipAtTrack,
  clipEnd,
  clipStart,
  duplicateClips,
  findClip,
  moveClipsToTrack,
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
  trackById,
  trackTypeById,
  type Clip,
  type ClipId,
  type TrackId,
  type Project,
} from '../../model/project.js'
import type { Track } from '../../model/project.js'
import type { History } from './history.js'
import type { Selection } from './selection.js'

export interface EditDeps {
  project: Project
  history: History
  selection: Selection
  audio: AudioEngine
  notify: (kind: 'info' | 'warn' | 'error', text: string) => void
  /** The only way the timeline changes. Never `reconcile` — see project-store. */
  setTracks: (tracks: Track[]) => void
  playhead: () => number
}

export interface EditSlice {
  splitAt: (time: number, trackId?: TrackId) => void
  splitSelectionAtPlayhead: () => void
  trimSelectionToPlayhead: () => void
  deleteSelected: () => void
  trimToPlayhead: (clipId: ClipId) => void
  clearTrack: (trackId: TrackId) => void
  duplicateSelected: () => void
  reorder: (trackId: TrackId, from: number, to: number) => void
  place: (trackId: TrackId, index: number, start: number) => void
  moveSelection: (trackId: TrackId, index: number, start: number) => void
  moveSelectionToTrack: (targetTrackId: TrackId, anchorClipId: ClipId, start: number) => void
  trim: (trackId: TrackId, index: number, inPoint: number, outPoint: number) => void
  setTransform: (clipId: ClipId, transform: Clip['transform']) => void
  setClipGain: (clipId: ClipId, gain: number) => void
  toggleMuteSelected: () => void
  toggleMute: (clipId: ClipId) => void
  toggleHideSelected: () => void
  toggleHiddenSelected: () => void
  toggleHidden: (clipId: ClipId) => void
  breakSelectedLinks: () => void
  selectionHasLinks: () => boolean
  replace: (next: Project) => Track[]
}

export function createEdits(deps: EditDeps): EditSlice {
  const { project, history, selection: sel, audio, notify, setTracks, playhead } = deps

  const replace = (next: Project): Track[] => next.tracks.map((t) => ({ ...t, clips: t.clips.slice() }))
  const setProject = (tracks: Track[]): void => setTracks(tracks)

  function splitCore(time: number, trackId?: TrackId): { next: Project; split: number } {
    const before = unwrap(project)
    let next = before
    let split = 0

    const cutOnly = (id: TrackId): void => {
      const clips = trackById(next, id)
      const loc = clipAtTrack(clips, time)
      if (!loc) return
      const after = splitClip(next, id, loc.index, time)
      if (after === next) return
      next = after
      split += 1
    }

    const cutPair = (id: TrackId): void => {
      const clips = trackById(next, id)
      const loc = clipAtTrack(clips, time)
      if (!loc) return
      const after = splitLinked(next, id, loc.index, time)
      if (after === next) return
      next = after
      split += 1
    }

    if (trackId) {
      cutOnly(trackId)
    } else {
      const selected = sel.clips()
      const trackIds = new Set(selected.map((c) => c.trackId))
      if (trackIds.size === 1) {
        cutOnly(selected[0]!.trackId)
      } else {
        for (const track of next.tracks) {
          if (track.type === 'video' || track.type === 'audio') {
            cutPair(track.id)
          }
        }
      }
    }

    return { next, split }
  }

  function splitAt(time: number, trackId?: TrackId): void {
    const { next, split } = splitCore(time, trackId)
    if (split === 0) {
      notify('info', 'Nothing to split — put the playhead inside a clip.')
      return
    }
    history.commit()
    setProject(replace(next))
  }

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

  function trimSelectionToPlayhead(): void {
    const t = playhead()
    const clips = sel.clips()
    if (clips.length === 0) return

    const targets = clips
      .map((c) => findClip(project, c.id)!)
      .filter(Boolean)

    const usable = targets.filter(({ trackId, index }) => {
      const clips = trackById(project, trackId)
      return clipStart(clips, index) < t && t < clipEnd(clips, index)
    })
    if (usable.length === 0) {
      notify('info', 'Move the playhead inside a selected clip to trim it.')
      return
    }

    history.commit()
    for (const { clip, trackId, index } of usable) {
      const clips = trackById(project, trackId)
      const start = clipStart(clips, index)
      const at = sourceTimeAt({ clip, index, start }, t)
      if (t - start < clipEnd(clips, index) - t) {
        trim(trackId, index, at, clip.out)
      } else {
        trim(trackId, index, clip.in, at)
      }
    }
  }

  function deleteSelected(): void {
    const clips = sel.clips()
    if (clips.length === 0) return
    history.commit()
    const doomed = clips
      .map((clip) => findClip(project, clip.id)!)
      .filter(Boolean)
      .sort((a, b) => b.trackId.localeCompare(a.trackId) || b.index - a.index)
    for (const { trackId, index } of doomed) {
      setProject(replace(removeClip(unwrap(project), trackId, index)))
    }
    sel.clear()
    notify('info', clips.length === 1 ? 'Deleted clip.' : `Deleted ${clips.length} clips.`)
  }

  function trimToPlayhead(clipId: ClipId): void {
    const found = findClip(project, clipId)
    if (!found) return
    const clips = trackById(project, found.trackId)
    const loc = clipAtTrack(clips, playhead())
    if (!loc || loc.clip.id !== clipId) {
      notify('info', 'Move the playhead over the clip first.')
      return
    }
    const at = sourceTimeAt(loc, playhead())
    if (at > found.clip.out) trim(found.trackId, found.index, found.clip.in, at)
    else trim(found.trackId, found.index, at, found.clip.out)
  }

  function clearTrack(trackId: TrackId): void {
    if (trackById(project, trackId).length === 0) return
    history.commit()
    const before = unwrap(project)
    setTracks(before.tracks.map((t) => (t.id === trackId ? { ...t, clips: [] } : t)))
    sel.replaceAll(sel.ids().filter((id) => findClip(project, id)?.trackId !== trackId))
    notify('info', `Cleared track ${trackId}.`)
  }

  function duplicateSelected(): void {
    const clips = sel.clips()
    if (clips.length === 0) return
    history.commit()
    const next = duplicateClips(unwrap(project), clips.map((c) => c.id))
    const copies: ClipId[] = []
    for (const track of next.tracks) {
      const wanted = new Set(clips.filter((c) => c.trackId === track.id).map((c) => c.id))
      const trackClips = track.clips
      for (let i = 0; i < trackClips.length; i += 1) {
        if (i > 0 && wanted.has(trackClips[i - 1]!.id)) copies.push(trackClips[i]!.id)
      }
    }
    setTracks(next.tracks)
    sel.replaceAll(copies)
    notify('info', copies.length === 1 ? 'Duplicated clip.' : `Duplicated ${copies.length} clips.`)
  }

  function reorder(trackId: TrackId, from: number, to: number): void {
    if (from === to) return
    setProject(replace(moveClip(unwrap(project), trackId, from, to)))
  }

  function place(trackId: TrackId, index: number, start: number): void {
    setProject(replace(placeClip(unwrap(project), trackId, index, start)))
  }

  function moveSelection(trackId: TrackId, index: number, start: number): void {
    const ids = sel.ids()
    if (ids.length < 2) return
    setProject(replace(moveSelectionTo(unwrap(project), trackId, index, start, new Set(ids))))
  }

  function moveSelectionToTrack(targetTrackId: TrackId, anchorClipId: ClipId, start: number): void {
    const ids = sel.ids()
    if (ids.length === 0) return
    setProject(replace(moveClipsToTrack(unwrap(project), targetTrackId, new Set(ids), anchorClipId, start)))
  }

  function trim(trackId: TrackId, index: number, inPoint: number, outPoint: number): void {
    setProject(replace(applyTrim(unwrap(project), trackId, index, inPoint, outPoint)))
  }

  function setTransform(clipId: ClipId, transform: Clip['transform']): void {
    setProject(replace(applyTransform(unwrap(project), clipId, transform!)))
  }

  function setClipGain(clipId: ClipId, gain: number): void {
    setProject(replace(applyGain(unwrap(project), clipId, gain)))
    const found = findClip(project, clipId)
    if (found) audio.setClipGain(found.clip)
  }

  function toggleHideSelected(): void {
    const clips = sel.clips()
    if (clips.length === 0) return
    const audible = clips.filter((c) => trackTypeById(project, c.trackId) === 'audio')
    const video = clips.filter((c) => trackTypeById(project, c.trackId) === 'video')
    if (audible.length === 0 && video.length === 0) return

    const shouldHide = [...audible, ...video].some((c) => !(trackTypeById(project, c.trackId) === 'audio' ? c.muted : c.hidden))
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
    const parts: string[] = []
    if (audible.length > 0) parts.push(shouldHide ? 'muted' : 'unmuted')
    if (video.length > 0) parts.push(shouldHide ? 'hidden' : 'shown')
    const noun = audible.length > 0 && video.length > 0 ? 'clips' : 'clip'
    notify('info', `${parts.join(' and ')} ${changed} ${noun}${changed === 1 ? '' : 's'}.`)
  }

  function toggleHiddenSelected(): void {
    const clips = sel.clips().filter((c) => trackTypeById(project, c.trackId) === 'video')
    if (clips.length === 0) return
    const shouldHide = clips.some((c) => !c.hidden)
    for (const clip of clips) {
      if (Boolean(clip.hidden) === shouldHide) continue
      setProject(replace(applyHidden(unwrap(project), clip.id)))
    }
    notify('info', `${shouldHide ? 'Hid' : 'Showed'} ${clips.length} clip${clips.length === 1 ? '' : 's'}.`)
  }

  function toggleHidden(clipId: ClipId): void {
    const before = findClip(project, clipId)
    if (!before) return
    const isAudio = trackTypeById(project, before.trackId) === 'audio'
    setProject(replace(
      isAudio ? applyMute(unwrap(project), clipId) : applyHidden(unwrap(project), clipId),
    ))
    if (isAudio) {
      const found = findClip(project, clipId)
      if (found) audio.setClipGain(found.clip)
    }
  }

  function toggleMuteSelected(): void {
    const clips = sel.clips().filter((c) => trackTypeById(project, c.trackId) === 'audio')
    if (clips.length === 0) return
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
    clearTrack,
    duplicateSelected,
    reorder,
    place,
    moveSelection,
    moveSelectionToTrack,
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
