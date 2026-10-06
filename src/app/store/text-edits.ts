/**
 * Text overlay edits.
 *
 * The same shape as `edits.ts`: a slice that owns no state of its own, wraps
 * each mutation in a `history.commit()` so undo sees it, and writes the whole
 * array back through one seam. Keeping it separate from clip edits matters
 * because the two share nothing but the project — a title is not a clip, and
 * pretending it is would leak into trimming, snapping and export scheduling.
 *
 * `deleteActive` is the one place the two worlds meet, and it resolves the
 * ambiguity in favour of the most recent explicit selection: clips win when
 * any are selected, otherwise the active title goes. That keeps a single
 * Delete key from ever destroying something the user was not looking at.
 */

import type { Accessor } from 'solid-js'
import type { Project } from '../../model/project.js'
import { newId } from '../../model/project.js'
import {
  createTextClip,
  removeTextClip,
  updateTextClip,
  type TextClip,
  type TextId,
  type TextInit,
  type TextPatch,
} from '../../model/text.js'
import type { History } from './history.js'

export interface TextEditDeps {
  project: Project
  history: History
  setTexts: (texts: TextClip[]) => void
  playhead: () => number
  selectionCount: () => number
  deleteClips: () => void
  activeTextId: Accessor<TextId | null>
  setActiveTextId: (id: TextId | null) => void
}

export interface TextSlice {
  texts: Accessor<TextClip[]>
  activeTextId: Accessor<TextId | null>
  activeText: Accessor<TextClip | null>
  hasActiveText: Accessor<boolean>
  setActiveText: (id: TextId | null) => void
  addText: (init?: TextInit) => TextId
  updateText: (id: TextId, patch: TextPatch, options?: { commit?: boolean }) => void
  moveText: (id: TextId, start: number, options?: { commit?: boolean }) => void
  removeText: (id: TextId) => void
  removeActiveText: () => void
  duplicateActiveText: () => void
  deleteActive: () => void
}

export function createTextEdits(deps: TextEditDeps): TextSlice {
  const texts = (): TextClip[] => deps.project.texts ?? []

  const activeText = (): TextClip | null => {
    const id = deps.activeTextId()
    return id ? texts().find((t) => t.id === id) ?? null : null
  }

  function updateText(id: TextId, patch: TextPatch, options: { commit?: boolean } = {}): void {
    if (options.commit !== false) deps.history.commit()
    deps.setTexts(updateTextClip(texts(), id, patch))
  }

  function addText(init: TextInit = {}): TextId {
    const id = newId('text')
    const start = init.start ?? deps.playhead()
    deps.history.commit()
    deps.setTexts([...texts(), createTextClip(id, start, init)])
    deps.setActiveTextId(id)
    return id
  }

  function removeText(id: TextId): void {
    deps.history.commit()
    deps.setTexts(removeTextClip(texts(), id))
    if (deps.activeTextId() === id) deps.setActiveTextId(null)
  }

  function duplicateActiveText(): void {
    const source = activeText()
    if (!source) return
    const id = newId('text')
    deps.history.commit()
    // Butted right after the original, the way duplicating a clip works, so a
    // title can be split into two cards by duplicating and retyping.
    deps.setTexts([...texts(), { ...source, id, start: source.start + source.duration, style: { ...source.style } }])
    deps.setActiveTextId(id)
  }

  function deleteActive(): void {
    if (deps.selectionCount() > 0) {
      deps.deleteClips()
      return
    }
    if (deps.activeTextId()) removeText(deps.activeTextId()!)
  }

  return {
    texts,
    activeTextId: deps.activeTextId,
    activeText,
    hasActiveText: () => deps.activeTextId() !== null,
    setActiveText: deps.setActiveTextId,
    addText,
    updateText,
    moveText: (id, start, options) => updateText(id, { start }, options),
    removeText,
    removeActiveText: () => {
      const id = deps.activeTextId()
      if (id) removeText(id)
    },
    duplicateActiveText,
    deleteActive,
  }
}
