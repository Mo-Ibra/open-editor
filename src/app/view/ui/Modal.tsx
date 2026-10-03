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

import { Show, type JSX } from 'solid-js'
import { X } from 'lucide-solid'

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
        class={`flex min-h-0 flex-col overflow-hidden bg-panel shadow-modal ${
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
