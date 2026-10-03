/**
 * The shared overlay.
 *
 * Every dialog in the app — projects, media, keyboard, logs, export — is the
 * same three things: a backdrop that closes on a click outside, a surface that
 * sits on it, and content. Spelling that out five times is how the panels drift
 * apart (they had three different paddings, two different close buttons and two
 * different backdrop strengths). One component means one of each.
 *
 * `panelAttrs` keeps the source-level test hooks (`data-projects-panel`,
 * `data-media-panel`, …) on the panel element, which is where a probe looks.
 */

import { onCleanup, onMount, Show, type JSX } from 'solid-js'
import { X } from 'lucide-solid'

/** Everything a Tab can land on inside the panel. */
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export type ModalPlacement = 'center' | 'top' | 'right'

export function Modal(props: {
  onClose: () => void
  /** Where the panel sits. `right` is the full-height log drawer. */
  placement?: ModalPlacement
  /** A border on all sides (`panel`) or only the leading edge (`drawer`). */
  variant?: 'panel' | 'drawer'
  /** `heavy` is the export dialog, which dims the editor almost to black. */
  tone?: 'default' | 'heavy'
  z?: number
  /** Layout only — sizes, max heights, widths. */
  panelClass?: string
  /** Extra attributes for the panel element, such as test hooks. */
  panelAttrs?: Record<string, string | number | boolean | undefined>
  onDragOver?: JSX.EventHandlerUnion<HTMLDivElement, DragEvent>
  onDragLeave?: JSX.EventHandlerUnion<HTMLDivElement, DragEvent>
  onDrop?: JSX.EventHandlerUnion<HTMLDivElement, DragEvent>
  children: JSX.Element
}) {
  const placement = (): ModalPlacement => props.placement ?? 'center'
  const isPanel = (): boolean => (props.variant ?? 'panel') === 'panel'
  let panelEl: HTMLDivElement | undefined

  /*
   * Focus moves into the dialog and is trapped there, then handed back.
   *
   * Without this, opening a panel left focus on the page behind it, so Tab
   * walked the editor underneath and a screen reader never announced the panel.
   * The panel itself takes focus (not its first button) so Enter cannot
   * accidentally fire an action; Tab from there reaches the controls.
   */
  onMount(() => {
    const previous = document.activeElement as HTMLElement | null
    panelEl?.focus()

    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab' || !panelEl) return
      const items = [...panelEl.querySelectorAll<HTMLElement>(FOCUSABLE)]
      if (items.length === 0) {
        event.preventDefault()
        return
      }
      const first = items[0]!
      const last = items[items.length - 1]!
      const active = document.activeElement
      if (event.shiftKey && (active === first || active === panelEl)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKey)
    onCleanup(() => {
      document.removeEventListener('keydown', onKey)
      // Return focus where it was, so closing a panel does not dump the user at
      // the top of the document.
      if (previous && document.contains(previous)) previous.focus()
    })
  })

  return (
    <div
      class="fixed inset-0 flex"
      classList={{
        'bg-black/35': (props.tone ?? 'default') === 'default',
        'bg-black/70 backdrop-blur-sm': props.tone === 'heavy',
        'items-start justify-center pt-[8vh]': placement() === 'top',
        'items-center justify-center p-6': placement() === 'center',
        'justify-end': placement() === 'right',
      }}
      style={{ 'z-index': String(props.z ?? 40) }}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) props.onClose()
      }}
      onDragOver={props.onDragOver}
      onDragLeave={props.onDragLeave}
      onDrop={props.onDrop}
    >
      <div
        ref={panelEl}
        role="dialog"
        aria-modal="true"
        tabindex={-1}
        class={`flex min-h-0 flex-col overflow-hidden bg-panel shadow-modal outline-none ${
          isPanel() ? 'rounded-panel border border-line' : 'border-l border-line'
        } ${props.panelClass ?? ''}`}
        {...(props.panelAttrs as JSX.HTMLAttributes<HTMLDivElement>)}
      >
        {props.children}
      </div>
    </div>
  )
}

/** A close affordance — the X, in the shared header or standalone. */
export function CloseButton(props: { onClick: () => void; label?: string }) {
  return (
    <button class="icon-btn" onClick={props.onClick} aria-label={props.label ?? 'Close'}>
      <X size={16} />
    </button>
  )
}

/**
 * The panel header: a small uppercase title, optional actions, and the close
 * button. Every panel renders one so they line up.
 */
export function PanelHeader(props: {
  title: string
  onClose?: () => void
  children?: JSX.Element
  class?: string
}) {
  return (
    <header
      class={`flex shrink-0 items-center gap-2 border-b border-line-soft px-3 py-2.5 ${props.class ?? ''}`}
    >
      <span class="panel-label">{props.title}</span>
      <span class="flex-1" />
      {props.children}
      <Show when={props.onClose}>
        <CloseButton onClick={() => props.onClose?.()} />
      </Show>
    </header>
  )
}
