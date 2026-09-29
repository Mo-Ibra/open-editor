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
import type { LayoutState } from '../store/layout.js'
import type { Fullscreen } from '../view/fullscreen.js'
import { shouldSuppressNativeMenu } from '../view/ContextMenu.js'

export interface ShortcutContext {
  state: AppState
  /** Anything that owns a menu — Escape closes it as well as deselecting. */
  closeMenu: () => void
  layout: LayoutState
  fullscreen: Fullscreen
  /** Opens the keyboard reference. `?` is where everyone looks for it. */
  openKeys: () => void
}

export function createShortcuts({ state, closeMenu, layout, fullscreen, openKeys }: ShortcutContext): Shortcut[] {
  const hasClips = (): boolean => state.project.video.length > 0 || state.project.audio.length > 0
  const hasSelection = (): boolean => state.selectionCount() > 0

  /** What `M` will do to the current selection, in the legend's own words. */
  const muteLabel = (): string => {
    const clips = state.selectedClips()
    if (clips.length === 0) return 'mute all'
    const audio = clips.filter((c) => c.lane === 'audio')
    const video = clips.filter((c) => c.lane === 'video')
    if (video.length === 0) return audio.every((c) => c.muted) ? 'unmute selection' : 'mute selection'
    if (audio.length === 0) return video.every((c) => c.hidden) ? 'show picture' : 'hide picture'
    return 'mute and hide selection'
  }

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
      // The label follows the selection, because the key does: audio clips are
      // muted, video clips are hidden, and a mixed selection does both. A legend
      // that said "mute" over a video selection was a small lie.
      label: muteLabel,
      // Mutes the selection when there is one and the master otherwise —
      // otherwise there would be no way to mute the whole project mid-edit.
      run: () =>
        state.selectionCount() > 0
          ? state.toggleHideSelected()
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
    // The keymap left the footer, so it needs a key of its own — or moving it
    // would have made it harder to find than the thing it replaced.
    { keys: ['?'], hint: '?', label: 'keyboard', run: openKeys },

    // --- panels ------------------------------------------------------------
    // The panels were collapsible only by double-clicking a 1px hairline, so
    // these give the same three actions names and keys. `\` is the convention
    // editors already use for the bottom panel.
    {
      keys: ['h'],
      hint: 'H',
      label: 'hide picture',
      run: () => layout.togglePicture(),
    },
    {
      keys: ['f'],
      hint: 'F',
      label: 'full screen',
      // Disabled rather than hidden when there is no picture to enlarge, and the
      // legend then reads "full screen" with the key inert — which is the same
      // honesty the context menu keeps.
      enabled: () => !layout.pictureHidden(),
      run: fullscreen.toggle,
    },
    {
      keys: ['\\'],
      hint: '\\',
      label: 'toggle timeline',
      run: () => layout.toggleTimeline(),
    },
    {
      keys: ['\\'],
      accel: true,
      hint: '⌘\\',
      label: 'toggle media',
      run: () => layout.toggleSidebar(),
    },

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
