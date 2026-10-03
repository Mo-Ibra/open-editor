/**
 * A tooltip for controls that are an icon and nothing else.
 *
 * The native `title` attribute is the accessible baseline and stays on every
 * control; this is the *visible* version, because a title waits a second, then
 * appears wherever the OS feels like it — and a video editor's controls are
 * used at speed. Wrapping an icon button here gives an immediate, styled label
 * and still leaves the accessible name on the button itself.
 *
 * Positioning is Floating UI, so a tooltip near the edge of the window flips
 * instead of being cut off.
 */

import { createEffect, createSignal, Show, type JSX } from 'solid-js'
import { computePosition, flip, offset, shift } from '@floating-ui/dom'

export function Tooltip(props: {
  label: string
  side?: 'top' | 'bottom' | 'left' | 'right'
  children: JSX.Element
}) {
  let anchor: HTMLSpanElement | undefined
  const [open, setOpen] = createSignal(false)
  const [tipEl, setTipEl] = createSignal<HTMLDivElement>()
  const [pos, setPos] = createSignal({ x: 0, y: 0 })

  createEffect(() => {
    const el = tipEl()
    if (!open() || !anchor || !el) return
    void computePosition(anchor, el, {
      placement: props.side ?? 'top',
      middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 })],
    }).then(({ x, y }) => setPos({ x, y }))
  })

  return (
    <span
      ref={anchor}
      class="inline-flex"
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocusIn={() => setOpen(true)}
      onFocusOut={() => setOpen(false)}
    >
      {props.children}
      <Show when={open()}>
        <div
          ref={setTipEl}
          role="tooltip"
          class="pointer-events-none fixed z-[60] whitespace-nowrap rounded-md border border-line bg-raised px-2 py-1 text-mini text-fg shadow-pop"
          style={{ left: `${pos().x}px`, top: `${pos().y}px` }}
        >
          {props.label}
        </div>
      </Show>
    </span>
  )
}
