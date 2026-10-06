/**
 * Undo history.
 *
 * A snapshot of the edit. That is the whole design: the project is data, so
 * undo is a stack of values rather than a set of inverse operations. There is
 * no undo engine here and there should not be one.
 *
 * The snapshot now holds tracks AND text overlays, because both are the edit
 * and either can be undone. Snapshots deliberately exclude `assets`. A clip or
 * title edit can only change these two arrays, and leaving the (potentially
 * large) asset table out keeps an entry to a few hundred bytes and makes the
 * cap of 100 free.
 */

import { createSignal, type Accessor } from 'solid-js'
import { unwrap } from 'solid-js/store'
import type { Track } from '../../model/project.js'
import type { Project } from '../../model/project.js'
import type { TextClip } from '../../model/text.js'

const HISTORY_LIMIT = 100

/** The reversible part of a project: everything an edit can touch. */
export interface HistoryDoc {
  tracks: Track[]
  texts: TextClip[]
}

export interface History {
  canUndo: Accessor<boolean>
  canRedo: Accessor<boolean>
  /** Record the current edit as the state to return to. Call BEFORE an edit. */
  commit: () => void
  undo: () => void
  redo: () => void
}

export function createHistory(
  project: Project,
  /** Write the edit back, without recording history. */
  restore: (doc: HistoryDoc) => void,
  /** A selection naming reverted clips must go, or the next edit hits a ghost. */
  onRestore: () => void,
): History {
  const [past, setPast] = createSignal<HistoryDoc[]>([])
  const [future, setFuture] = createSignal<HistoryDoc[]>([])

  const snapshot = (): HistoryDoc => {
    const live = unwrap(project)
    return {
      tracks: live.tracks.map((t) => ({ ...t, clips: t.clips.slice() })),
      // A text carries a nested style object, so the copy has to reach one
      // level deeper or a later style edit would mutate the snapshot too.
      texts: (live.texts ?? []).map((t) => ({ ...t, style: { ...t.style } })),
    }
  }

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
