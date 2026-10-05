/**
 * Clip selection.
 *
 * Split out of `state.ts` because it is a self-contained concern with a
 * surprising amount of policy in it: what a plain click does to an existing
 * multi-selection, which clip a range extends from, and when a selection is
 * allowed to outlive the clips it names.
 *
 * It needs the project only to read clip ids, which is what makes it testable
 * without a browser and re-usable without dragging the rest of the store along.
 */

import { createSignal, type Accessor } from 'solid-js'
import type { Clip, ClipId, TrackId, Project } from '../../model/project.js'

/** How a click changes the selection. */
export type SelectMode = 'replace' | 'toggle' | 'range'

export interface Selection {
  /** Selected clip ids, in click order. The last is the *primary*. */
  ids: Accessor<readonly ClipId[]>
  primary: Accessor<ClipId | null>
  isSelected: (clipId: ClipId) => boolean
  count: Accessor<number>
  /** The selected clips, in timeline order. */
  clips: Accessor<Clip[]>
  /** Which tracks hold at least one selected clip. */
  tracks: Accessor<TrackId[]>
  select: (clipId: ClipId, mode?: SelectMode) => void
  /**
   * Replace the entire selection with a computed set.
   *
   * Distinct from `select(id, 'replace')`, which deliberately no-ops when the
   * clip is already the sole selection. This is the blunt version, for callers
   * that already know the exact answer: selecting a copy an edit just made, or
   * keeping only the clips that survived clearing a track.
   */
  replaceAll: (ids: readonly ClipId[]) => void
  /** Promote a clip to primary without changing membership. */
  setPrimary: (clipId: ClipId) => void
  clear: () => void
  selectAll: () => void
  /**
   * Drop ids that no longer exist. Called after every project write, because a
   * selection that outlives its clips is a live hazard: batch actions resolve
   * their targets through it, so one deleted clip left selected would silently
   * swallow the next Delete.
   */
  prune: () => void
}

export function createSelection(project: Project): Selection {
  const [ids, setIds] = createSignal<readonly ClipId[]>([])

  /** Every clip on screen, in timeline order. */
  const orderedClips = (): Clip[] => {
    const clips: Clip[] = []
    for (const track of project.tracks) clips.push(...track.clips)
    return clips
  }

  const primary = (): ClipId | null => ids().at(-1) ?? null
  const isSelected = (clipId: ClipId): boolean => ids().includes(clipId)
  const count = (): number => ids().length
  const clips = (): Clip[] => orderedClips().filter((c) => isSelected(c.id))
  const tracks = (): TrackId[] => {
    const set = new Set<TrackId>()
    for (const clip of clips()) set.add(clip.trackId)
    return [...set]
  }

  function select(clipId: ClipId, mode: SelectMode = 'replace'): void {
    const current = ids()
    if (mode === 'replace') {
      if (current.length > 1 && current.includes(clipId)) {
        setPrimary(clipId)
        return
      }
      setIds([clipId])
      return
    }
    if (mode === 'toggle') {
      setIds(current.includes(clipId) ? current.filter((id) => id !== clipId) : [...current, clipId])
      return
    }
    const anchor = primary() ?? current[0] ?? clipId
    const order = orderedClips().map((c) => c.id)
    const a = order.indexOf(anchor)
    const b = order.indexOf(clipId)
    if (a < 0 || b < 0) {
      setIds([clipId])
      return
    }
    const [from, to] = a < b ? [a, b] : [b, a]
    const span = order.slice(from, to + 1)
    setIds([...new Set([...span, ...current])])
  }

  function replaceAll(next: readonly ClipId[]): void {
    setIds(next)
  }

  function setPrimary(clipId: ClipId): void {
    if (!isSelected(clipId)) return
    setIds([...ids().filter((id) => id !== clipId), clipId])
  }

  function clear(): void {
    setIds([])
  }

  function selectAll(): void {
    setIds(orderedClips().map((c) => c.id))
  }

  function prune(): void {
    const live = new Set(orderedClips().map((c) => c.id))
    const kept = ids().filter((id) => live.has(id))
    if (kept.length !== ids().length) setIds(kept)
  }

  return {
    ids, primary, isSelected, count, clips, tracks,
    select, replaceAll, setPrimary, clear, selectAll, prune,
  }
}
