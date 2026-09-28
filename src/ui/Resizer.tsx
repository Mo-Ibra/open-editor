/**
 * A draggable divider between two panels.
 *
 * Geometry and clamping live in `src/layout.ts`; this only reports the
 * gesture, so the two panels cannot disagree about what a drag means.
 *
 * Deliberately 5px wide and *visibly* draggable on hover, but only ~1px of it
 * is ever visible at rest. A fat handle eats timeline pixels; a hairline is
 * impossible to find.
 */

import type { JSX } from 'solid-js'

export function Resizer(props: {
  /** 'x' = a vertical bar, dragged horizontally. 'y' = a horizontal bar. */
  axis: 'x' | 'y'
  /**
   * The CSS inset that puts the handle on the boundary between the two panels.
   *
   * This has to be explicit. An absolutely positioned child of a grid with
   * `left: auto` falls back to its *static* position, which is the container's
   * content origin — so a handle that did not name its own position would sit
   * on top of the first panel instead of between the two. The caller knows
   * where the boundary is; this component only draws it.
   */
  at: JSX.CSSProperties
  onDrag: (event: PointerEvent) => void
  onToggle: () => void
  collapsed?: boolean
  title: string
}) {
  return (
    <div
      class="group absolute z-30 flex items-center justify-center"
      classList={{
        'top-0 bottom-0 w-1.5 cursor-col-resize': props.axis === 'x',
        'left-0 right-0 h-1.5 cursor-row-resize': props.axis === 'y',
        // Centred on the boundary, except when a panel has collapsed to 0px —
        // then half the handle would hang off-screen, so it sits just inside.
        '-translate-x-1/2': props.axis === 'x' && !props.collapsed,
        '-translate-y-1/2': props.axis === 'y' && !props.collapsed,
        'translate-x-3': props.axis === 'x' && props.collapsed,
        'translate-y-3': props.axis === 'y' && props.collapsed,
      }}
      style={props.at}
      onPointerDown={props.onDrag}
      onDblClick={props.onToggle}
      title={props.title}
      role="separator"
      aria-orientation={props.axis === 'x' ? 'vertical' : 'horizontal'}
    >
      {/* The hairline, and the hit area that makes it findable on hover. */}
      <div
        class="absolute bg-accent opacity-0 transition-opacity group-hover:opacity-100"
        classList={{
          'inset-y-0 left-1/2 w-px -translate-x-1/2': props.axis === 'x',
          'inset-x-0 top-1/2 h-px -translate-y-1/2': props.axis === 'y',
        }}
      />
      <div
        class="absolute opacity-0 transition-opacity group-hover:opacity-90"
        classList={{
          'h-8 w-1 rounded-full bg-accent/70': props.axis === 'x',
          'w-8 h-1 rounded-full bg-accent/70': props.axis === 'y',
        }}
      />
    </div>
  )
}
