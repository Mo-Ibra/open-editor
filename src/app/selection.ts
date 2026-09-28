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
import type { Clip, ClipId, Lane, Project } from '../model/project.js'

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
  /** Which lanes hold at least one selected clip. */
  lanes: Accessor<Lane[]>
  select: (clipId: ClipId, mode?: SelectMode) => void
  /**
   * Replace the entire selection with a computed set.
   *
   * Distinct from `select(id, 'replace')`, which deliberately no-ops when the
   * clip is already the sole selection. This is the blunt version, for callers
   * that already know the exact answer: selecting a copy an edit just made, or
   * keeping only the clips that survived clearing a lane.
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
  /**
   * The clip selection, in click order. The last entry is the *primary* clip:
   * the one the inspector describes and the one a solo action applies to.
   *
   * An array rather than a Set because order carries meaning — it is what makes
   * a range extend from the primary — and because two-element arrays are free to
   * compare. A Set would need to be copied on every change anyway.
   */
  const [ids, setIds] = createSignal<readonly ClipId[]>([])

  /** Every clip on screen, in timeline order: video lane, then audio lane. */
  const orderedClips = (): Clip[] => [...project.video, ...project.audio]

  const primary = (): ClipId | null => ids().at(-1) ?? null
  const isSelected = (clipId: ClipId): boolean => ids().includes(clipId)
  const count = (): number => ids().length
  const clips = (): Clip[] => orderedClips().filter((c) => isSelected(c.id))
  const lanes = (): Lane[] => {
    const set = new Set<Lane>()
    for (const clip of clips()) set.add(clip.lane)
    return [...set]
  }

  /**
   * Select a clip.
   *
   * - `replace` is a plain click: one clip, whatever was selected before.
   * - `toggle` is ctrl/cmd-click: adds or removes, keeping the rest.
   * - `range` is shift-click: everything between the primary and this clip.
   *
   * A plain click on an already-selected clip **keeps** the selection rather than
   * collapsing to one. Otherwise ctrl-clicking three clips and then nudging one
   * of them would silently throw the other two away.
   */
  function select(clipId: ClipId, mode: SelectMode = 'replace'): void {
    const current = ids()
    if (mode === 'replace') {
      // A click on a clip that is *part of* a multi-selection keeps that
      // selection, promoting the clicked clip to primary. This is what lets you
      // click one of three selected clips to drag it without silently throwing
      // the other two away — the mistake this rule exists to prevent.
      //
      // A click on a clip that is NOT selected narrows to just it, which is
      // what "I want to work on this one" means.
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
    // range
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
    // Everything in the span, plus anything already selected outside it, so
    // ctrl-then-shift extends instead of discarding.
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
    ids, primary, isSelected, count, clips, lanes,
    select, replaceAll, setPrimary, clear, selectAll, prune,
  }
}
