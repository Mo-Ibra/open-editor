/**
 * The application's shortcuts, declared once.
 *
 * This is the single list behind both the key handler and the status-bar
 * legend. Adding a shortcut here adds it to both; the legend cannot advertise
 * something that does not exist, which is the bug this arrangement exists to
 * prevent.
 *
 * Mouse gestures are listed here too, flagged `gesture`, because the legend
 * shows them in the same row of hints. They are skipped by the matcher, and
 * `test/keyboard.test.ts` asserts they match the modes the timeline implements.
 */

import type { AppState } from '../store/state.js'
import type { Shortcut } from './keyboard.js'
import { shouldSuppressNativeMenu } from '../view/ContextMenu.js'

export interface ShortcutContext {
  state: AppState
  /** Anything that owns a menu — Escape closes it as well as deselecting. */
  closeMenu: () => void
}

export function createShortcuts({ state, closeMenu }: ShortcutContext): Shortcut[] {
  const hasClips = (): boolean => state.project.video.length > 0 || state.project.audio.length > 0
  const hasSelection = (): boolean => state.selectionCount() > 0

  return [
    { keys: [' '], hint: 'space', label: 'play', run: () => void state.togglePlay() },

    {
      keys: ['s'],
      hint: 'S',
      label: 'split',
      enabled: hasClips,
      // Several clips selected means split all of them; one (or none) keeps the
      // older behaviour of splitting whatever is under the playhead.
      run: () =>
        state.selectionCount() > 1
          ? state.splitSelectionAtPlayhead()
          : state.splitAt(state.playhead()),
    },

    {
      keys: ['d'],
      accel: true,
      hint: '⌘D',
      label: 'duplicate',
      enabled: hasSelection,
      run: () => state.duplicateSelected(),
    },

    {
      keys: ['a'],
      accel: true,
      hint: '⌘A',
      label: 'select all',
      run: () => state.selectAll(),
    },

    { keys: ['Backspace', 'Delete'], hint: '⌫', label: 'delete', enabled: hasSelection, run: () => state.deleteSelected() },

    { keys: ['ArrowLeft'], hint: '←', label: 'step', run: () => state.step(-1) },
    { keys: ['ArrowLeft'], shift: true, hint: '⇧←', label: 'step 10', run: () => state.step(-10) },
    { keys: ['ArrowRight'], hint: '→', label: 'step', run: () => state.step(1) },
    { keys: ['ArrowRight'], shift: true, hint: '⇧→', label: 'step 10', run: () => state.step(10) },

    { keys: ['Home'], hint: 'Home', label: 'go to start', run: () => state.seek(0) },
    { keys: ['End'], hint: 'End', label: 'go to end', run: () => state.seek(state.duration()) },

    {
      keys: ['m'],
      hint: 'M',
      label: 'mute selection',
      // Mutes the selection when there is one and the master otherwise —
      // otherwise there would be no way to mute the whole project mid-edit.
      run: () =>
        state.selectedLanes().includes('audio')
          ? state.toggleMuteSelected()
          : state.audio.setMuted(!state.audio.isMuted),
    },

    {
      keys: ['g'],
      hint: 'G',
      label: 'snap',
      run: () => {
        const next = !state.snapping()
        state.setSnapping(next)
        state.notify('info', `Snapping ${next ? 'on' : 'off'}`)
      },
    },

    { keys: ['z'], accel: true, hint: '⌘Z', label: 'undo', enabled: () => state.canUndo(), run: () => state.undo() },
    { keys: ['z'], accel: true, shift: true, hint: '⇧⌘Z', label: 'redo', enabled: () => state.canRedo(), run: () => state.redo() },

    { keys: ['Escape'], hint: 'esc', label: 'deselect', run: () => { state.clearSelection(); closeMenu() } },

    // --- not keyboard input; legend only. Matched against the timeline's own
    // select modes by test/keyboard.test.ts so the two cannot disagree.
    { keys: [], hint: '^click', label: 'add to selection', gesture: true, run: () => undefined },
    { keys: [], hint: '⇧click', label: 'extend selection', gesture: true, run: () => undefined },
    // Handled by a wheel listener on the timeline, not by a key. Listed here
    // because the legend is the only place the user looks for "what can I do",
    // and an undiscoverable zoom is the same as no zoom.
    { keys: [], hint: '^scroll', label: 'zoom timeline', gesture: true, run: () => undefined },
  ]
}

/**
 * The native context menu belongs to the user inside a text field, and to us
 * everywhere else — see `shouldSuppressNativeMenu` for the reasoning.
 */
export function suppressNativeMenu(event: MouseEvent): void {
  if (shouldSuppressNativeMenu(event)) event.preventDefault()
}
