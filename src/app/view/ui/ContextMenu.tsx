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

import { createEffect, createSignal, For, Show, type JSX } from 'solid-js'
import { computePosition, flip, offset, shift } from '@floating-ui/dom'
import { log } from '../../../dev/debug.js'

export interface MenuItem {
  label: string
  /** Renders a divider instead of a row. */
  separator?: boolean
  /**
   * Information, not an action — rendered as plain text with no pointer.
   *
   * The alternative is a permanently disabled row, which is the dead-row
   * pattern this file argues against everywhere else: it looks clickable and
   * does nothing, so it teaches the reader that the menu contains features
   * rather than facts. "unlinked" is a fact about the selection.
   */
  status?: boolean
  shortcut?: string
  disabled?: boolean
  danger?: boolean
  run: () => void
}

export interface MenuTarget {
  kind: 'clip' | 'track' | 'asset' | 'preview' | 'timeline' | 'text' | 'app'
  trackId?: string
  clipId?: string
  assetId?: string
  textId?: string
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
  const [menuEl, setMenuEl] = createSignal<HTMLDivElement>()
  const [pos, setPos] = createSignal({ left: 0, top: 0 })

  /*
   * Keep the menu on screen with Floating UI rather than arithmetic.
   *
   * The old version guessed the menu's height from the item count and clamped
   * against the window, which is wrong the moment a label wraps or the platform
   * font differs — a menu opened near the bottom edge would still be clipped.
   * Floating UI measures the real element and flips it above the pointer when
   * there is no room below, which is the behaviour people expect.
   *
   * The reference is a virtual element at the pointer: there is no trigger to
   * anchor to, only the click position.
   */
  createEffect(() => {
    const target = props.state.open()
    const el = menuEl()
    props.items() // re-place when the item set changes the menu's size
    if (!target || !el) return
    const virtual = {
      getBoundingClientRect: (): DOMRect => ({
        x: target.x,
        y: target.y,
        top: target.y,
        left: target.x,
        right: target.x,
        bottom: target.y,
        width: 0,
        height: 0,
        toJSON: () => ({}),
      }),
    }
    void computePosition(virtual as unknown as Element, el, {
      placement: 'bottom-start',
      middleware: [offset(4), flip({ padding: 8 }), shift({ padding: 8 })],
    }).then(({ x, y }) => setPos({ left: x, top: y }))
  })

  return (
    <Show when={props.state.open()}>
      {(target) => (
        <div
          ref={setMenuEl}
          data-menu
          class="fixed z-50 min-w-[200px] rounded-md border border-line bg-raised/98 py-1 shadow-pop backdrop-blur"
          style={{ left: `${pos().left}px`, top: `${pos().top}px` }}
          onContextMenu={(e) => e.preventDefault()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <For each={props.items()}>
            {(item) =>
              item.separator ? (
                <div class="my-1 h-px bg-line" />
              ) : item.status ? (
                <div class="px-3 py-1 text-mini text-muted">{item.label}</div>
              ) : (
                <button
                  class="flex w-full items-center gap-3 px-3 py-1 text-left text-small transition-colors hover:bg-accent/15 disabled:pointer-events-none disabled:opacity-35"
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
                    <kbd class="rounded border border-line bg-black/30 px-1 font-mono text-micro leading-[14px] text-muted">
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
