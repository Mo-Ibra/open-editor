/**
 * The shortcut reference, as a topbar panel.
 *
 * This list used to live permanently in the status bar, where it had grown to
 * twenty-four entries and two full rows of the editor's most valuable space.
 * A permanent keymap is a table of contents nobody reads: it is long, it never
 * changes, and it is not what you look at when you are cutting.
 *
 * A status bar's job is *now* — where the playhead is, what is selected, whether
 * snapping is on. A keymap's job is *reference*, which means it should be one
 * click away and then out of the way.
 *
 * Kept derived from the same descriptors the key handler uses, so a shortcut
 * cannot exist without appearing here. The earlier hand-written legend drifted
 * and advertised a key with no handler behind it.
 */

import { For } from 'solid-js'
import type { Shortcut } from '../commands/keyboard.js'

export function ShortcutsPanel(props: { shortcuts: Shortcut[]; onClose: () => void }) {
  // Grouped by the blank space between them in the source, so the panel's
  // sections are the author's sections rather than a guess made here.
  const groups = (): Shortcut[][] => {
    const out: Shortcut[][] = []
    for (const s of props.shortcuts) {
      if (s.gesture || out.length === 0) out.push([s])
      else out[out.length - 1]!.push(s)
    }
    return out
  }

  return (
    <div
      class="fixed inset-0 z-40 flex items-start justify-center bg-black/35 pt-[12vh]"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) props.onClose()
      }}
    >
      <div
        class="max-h-[76vh] w-[min(720px,92vw)] overflow-y-auto rounded-lg border border-line bg-panel shadow-2xl"
        data-shortcuts-panel
      >
        <header class="sticky top-0 flex items-center gap-2 border-b border-line-soft bg-panel px-4 py-2.5">
          <span class="panel-label">Keyboard</span>
          <span class="flex-1" />
          <button class="btn btn-ghost !px-2" onClick={props.onClose} aria-label="Close">
            close
          </button>
        </header>

        <div class="grid gap-x-8 gap-y-5 p-4 sm:grid-cols-2">
          <For each={groups()}>
            {(group) => (
              <section>
                <ul class="flex flex-col gap-1">
                  <For each={group}>
                    {(s) => (
                      <li class="flex items-baseline gap-3 text-[12px]">
                        <kbd class="timecode w-16 shrink-0 rounded border border-line bg-raised px-1.5 py-0.5 text-center text-[10.5px]">
                          {s.hint}
                        </kbd>
                        <span class="min-w-0 flex-1 text-muted">
                          {typeof s.label === 'function' ? s.label() : s.label}
                        </span>
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            )}
          </For>
        </div>
      </div>
    </div>
  )
}
