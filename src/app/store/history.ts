/**
 * Undo history.
 *
 * A snapshot of the tracks array. That is the whole design: the project is
 * data, so undo is a stack of values rather than a set of inverse operations.
 * There is no undo engine here and there should not be one.
 *
 * Snapshots deliberately exclude `assets`. A clip edit can only change tracks,
 * and leaving the (potentially large) asset table out keeps an entry to a few
 * hundred bytes and makes the cap of 100 free.
 */

import { createSignal, type Accessor } from 'solid-js'
import { unwrap } from 'solid-js/store'
import type { Track } from '../../model/project.js'
import type { Project } from '../../model/project.js'

const HISTORY_LIMIT = 100

export interface History {
  canUndo: Accessor<boolean>
  canRedo: Accessor<boolean>
  /** Record the current tracks as the state to return to. Call BEFORE an edit. */
  commit: () => void
  undo: () => void
  redo: () => void
}

export function createHistory(
  project: Project,
  /** Write tracks back, without recording history. */
  restore: (tracks: Track[]) => void,
  /** A selection naming reverted clips must go, or the next edit hits a ghost. */
  onRestore: () => void,
): History {
  const [past, setPast] = createSignal<Track[][]>([])
  const [future, setFuture] = createSignal<Track[][]>([])

  const snapshot = (): Track[] =>
    unwrap(project).tracks.map((t) => ({ ...t, clips: t.clips.slice() }))

  function commit(): void {
    const current = snapshot()
    setPast((prev) => [...prev.slice(-(HISTORY_LIMIT - 1)), current])
    setFuture([])
  }

  function undo(): void {
    const history = past()
    const previous = history.at(-1)
    if (!previous) return
    const current = snapshot()
    setPast(history.slice(0, -1))
    setFuture((f) => [...f, current])
    restore(previous)
    onRestore()
  }

  function redo(): void {
    const history = future()
    const next = history.at(-1)
    if (!next) return
    const current = snapshot()
    setFuture(history.slice(0, -1))
    setPast((p) => [...p, current])
    restore(next)
  }

  return {
    canUndo: () => past().length > 0,
    canRedo: () => future().length > 0,
    commit,
    undo,
    redo,
  }
}
