/**
 * The application context menu.
 *
 * Replaces the browser's, but **not everywhere**: inside a text field the
 * native menu is left alone, because suppressing it there removes paste and
 * spellcheck with nothing to show in exchange. The menu is for the app's
 * chrome, where the browser's list is a page link and "Reload" — a
 * genuinely dangerous action sitting where "Split" should be.
 *
 * Menus are built from the *target*, so every item is something the app can
 * actually do. A menu of disabled placeholders teaches people that right-click
 * is decoration.
 */

import { createSignal, For, Show, type JSX } from 'solid-js'
import { log } from '../debug.js'

export interface MenuItem {
  label: string
  /** Renders a divider instead of a row. */
  separator?: boolean
  shortcut?: string
  disabled?: boolean
  danger?: boolean
  run: () => void
}

export interface MenuTarget {
  kind: 'clip' | 'lane' | 'asset' | 'preview' | 'timeline' | 'app'
  lane?: 'video' | 'audio'
  clipId?: string
  assetId?: string
  /** Where the pointer was, in client coordinates. */
  x: number
  y: number
}

export function createContextMenu() {
  const [open, setOpen] = createSignal<MenuTarget | null>(null)

  function show(target: MenuTarget): void {
    setOpen(target)
  }

  function hide(): void {
    setOpen(null)
  }

  function toggle(target: MenuTarget): void {
    setOpen((current) => (current ? null : target))
  }

  // Any of these means the menu's premise has changed, so it must go.
  if (typeof window !== 'undefined') {
    window.addEventListener('pointerdown', (e) => {
      if (!(e.target as HTMLElement)?.closest?.('[data-menu]')) hide()
    })
    window.addEventListener('wheel', hide, { passive: true })
    window.addEventListener('resize', hide)
    window.addEventListener('blur', hide)
    window.addEventListener('keydown', (e) => e.key === 'Escape' && hide())
  }

  return { open, show, hide, toggle }
}

export type ContextMenuState = ReturnType<typeof createContextMenu>

/**
 * Suppress the native menu for app chrome, leave it for text entry.
 *
 * The check is on the *target*, so a right-click on a button inside a form
 * still offers the native menu if it is genuinely a text context.
 */
export function shouldSuppressNativeMenu(event: MouseEvent): boolean {
  const target = event.target as HTMLElement | null
  if (!target) return false
  if (target.isContentEditable) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return false
  // Inside a <select> the native menu is genuinely useful.
  if (target.closest('select')) return false
  return true
}

export function ContextMenu(props: {
  state: ContextMenuState
  /** Items for the current target. */
  items: () => MenuItem[]
}) {
  // Keep the menu on screen. A right-click near the bottom edge would
  // otherwise open a panel that extends past the viewport.
  function position(): { left: number; top: number } {
    const target = props.state.open()
    if (!target) return { left: 0, top: 0 }
    const width = 210
    const height = props.items().length * 26 + 12
    return {
      left: Math.min(target.x, window.innerWidth - width - 8),
      top: Math.min(target.y, window.innerHeight - height - 8),
    }
  }

  return (
    <Show when={props.state.open()}>
      {(target) => (
        <div
          data-menu
          class="fixed z-50 min-w-[200px] rounded-md border border-line bg-raised/98 py-1 shadow-xl shadow-black/50 backdrop-blur"
          style={{ left: `${position().left}px`, top: `${position().top}px` }}
          onContextMenu={(e) => e.preventDefault()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <For each={props.items()}>
            {(item) =>
              item.separator ? (
                <div class="my-1 h-px bg-line" />
              ) : (
                <button
                  class="flex w-full items-center gap-3 px-3 py-1 text-left text-[12px] transition-colors hover:bg-accent/15 disabled:pointer-events-none disabled:opacity-35"
                  classList={{ 'text-danger': item.danger }}
                  disabled={item.disabled}
                  onClick={() => {
                    props.state.hide()
                    item.run()
                    log.debug(`menu: ${item.label} (${target().kind})`)
                  }}
                >
                  <span class="flex-1 truncate">{item.label}</span>
                  <Show when={item.shortcut}>
                    <kbd class="rounded border border-line bg-black/30 px-1 font-mono text-[9.5px] leading-[14px] text-muted">
                      {item.shortcut}
                    </kbd>
                  </Show>
                </button>
              )
            }
          </For>
        </div>
      )}
    </Show>
  )
}

export type { JSX }
