/**
 * Keyboard shortcuts, as data.
 *
 * The legend in the status bar used to be a hand-written array sitting next to
 * the key handler, and the two drifted: it advertised `D — overlay` for months
 * with no handler behind it. Nothing catches that, because a legend entry that
 * describes nothing is still valid TypeScript and still renders.
 *
 * So there is exactly one list, and the legend is *derived* from it by
 * `shortcutLegend`. A shortcut cannot be added without appearing, or removed
 * without disappearing. `test/keyboard.test.ts` pins that.
 *
 * Matching is exact on both modifiers: a shortcut declaring `accel` only fires
 * with ctrl/cmd, and one declaring `shift` only fires with shift. That is what
 * lets `z` and `⇧⌘z` coexist, and it is why a bare `z` matches nothing rather
 * than accidentally hitting the undo binding.
 */

export interface Shortcut {
  /** Lowercased `KeyboardEvent.key` values that trigger it. */
  keys: string[]
  /** Requires ctrl or cmd. */
  accel?: boolean
  /** Requires shift. */
  shift?: boolean
  /** How the legend renders the key. */
  hint: string
  /**
   * What the legend calls it.
   *
   * A function where the meaning depends on the selection — `M` is "mute" over
   * audio clips and "hide picture" over video ones, and a legend that said
   * "mute" in both cases was quietly lying. Resolved when the legend renders.
   */
  label: string | (() => string)
  /** False to leave the key alone (e.g. nothing selected). */
  enabled?: () => boolean
  run: () => void
  /** Keys that are not keyboard input at all — shown in the legend only. */
  gesture?: boolean
}

/** Keys a focused button owns: it activates itself. */
const BUTTON_KEYS = new Set([' ', 'Enter'])

/**
 * Whether the event should be left alone.
 *
 * Inside a text field the native context menu and the browser's own key
 * handling both belong to the user, and hijacking `space` there would make
 * typing impossible. On a focused button, space and enter activate the button,
 * and also running the global binding would make one keypress do two things.
 */
export function shouldIgnore(target: EventTarget | null, key: string): boolean {
  const el = target as HTMLElement | null
  if (!el?.tagName) return false
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) return true
  return el.tagName === 'BUTTON' && BUTTON_KEYS.has(key)
}

/** Normalise `KeyboardEvent.key` for comparison. */
function normalise(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key
}

/** The shortcut this event triggers, or null. */
export function matchShortcut(shortcuts: readonly Shortcut[], event: KeyboardEvent): Shortcut | null {
  const key = normalise(event.key)
  const accel = event.ctrlKey || event.metaKey
  for (const s of shortcuts) {
    if (s.gesture) continue
    if (!s.keys.includes(key)) continue
    if (Boolean(s.accel) !== accel) continue
    if (Boolean(s.shift) !== event.shiftKey) continue
    if (s.enabled && !s.enabled()) continue
    return s
  }
  return null
}

/**
 * Build the global key handler.
 *
 * Every matched shortcut calls `preventDefault`. None of these keys has a
 * meaning worth keeping in an editor — space scrolls, backspace navigates — and
 * a per-shortlist opt-in would eventually be forgotten for the one that matters.
 */
export function createKeyHandler(shortcuts: readonly Shortcut[]): (event: KeyboardEvent) => void {
  return (event: KeyboardEvent) => {
    if (shouldIgnore(event.target, event.key)) return
    const shortcut = matchShortcut(shortcuts, event)
    if (!shortcut) return
    event.preventDefault()
    shortcut.run()
  }
}

/** The status-bar rows, in the order the shortcuts were declared. */
export function shortcutLegend(shortcuts: readonly Shortcut[]): { hint: string; label: string }[] {
  return shortcuts.map((s) => ({ hint: s.hint, label: typeof s.label === 'function' ? s.label() : s.label }))
}
