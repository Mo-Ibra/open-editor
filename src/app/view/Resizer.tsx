/**
 * A draggable divider between two panels, and the way back when one is closed.
 *
 * Geometry and clamping live in `layout.ts`; this only reports the gesture, so
 * the two panels cannot disagree about what a drag means.
 *
 * Deliberately 6px wide and *visibly* draggable on hover, but only ~1px of it is
 * ever visible at rest. A fat handle eats timeline pixels; a hairline is
 * impossible to find.
 *
 * **A collapsed panel gets a labelled tab**, not a bare arrow. A collapsed
 * panel is 0px with `overflow-hidden`, so a toggle rendered inside its header is
 * clipped out of existence; the only way back was a 1px hairline (or a bare
 * arrow that had to be discovered by luck). The tab is a sibling of the clipped
 * panel, sits on the boundary, and says which panel it brings back.
 */

import { Show } from 'solid-js'
import type { JSX } from 'solid-js'

export function Resizer(props: {
  /** 'x' = a vertical bar, dragged horizontally. 'y' = a horizontal bar. */
  axis: 'x' | 'right' | 'y'
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
  /** What the collapsed tab names — the panel it reopens. */
  label?: string
}) {
  const collapsed = (): boolean => Boolean(props.collapsed)
  const vertical = (): boolean => props.axis !== 'y'

  return (
    <div
      class="group absolute z-30 flex items-center justify-center"
      classList={{
        // Expanded: a hairline on the boundary, with a visible grab handle.
        'top-0 bottom-0 w-1.5 -translate-x-1/2 cursor-col-resize': vertical() && !collapsed(),
        'left-0 right-0 h-1.5 -translate-y-1/2 cursor-row-resize': !vertical() && !collapsed(),
        // Collapsed: a compact, labelled tab centred on the boundary. Its own
        // size, so it cannot inherit the hairline's conflicting width class.
        'top-1/2 h-24 w-6 -translate-y-1/2': vertical() && collapsed(),
        'left-1/2 h-6 w-24 -translate-x-1/2': !vertical() && collapsed(),
      }}
      style={props.at}
      // Collapsed, this is a button and nothing else. It used to also drag, and
      // that made the two fight: `onPointerDown` expanded the panel, and the
      // `click` that followed then collapsed it again — a button that appeared
      // to do nothing. "Drag the edge to reopen" was never discoverable anyway,
      // so the drag is dropped in favour of one gesture that always works.
      onPointerDown={collapsed() ? undefined : props.onDrag}
      onDblClick={props.onToggle}
      // Always attached, and the decision made inside.
      //
      // `onClick={collapsed() ? props.onToggle : undefined}` looks equivalent and
      // is not: the click arrived on the element and nothing happened. A
      // conditional *handler* is a value the delegated dispatcher has to read at
      // dispatch time, and a branch inside the handler has no such dependency.
      // Cheaper to reason about too — one path, not two.
      onClick={() => {
        // When the panel is open the handle is a 1px hairline, and a stray click
        // on it should not toggle anything.
        if (collapsed()) props.onToggle()
      }}
      title={props.title}
      role="separator"
      aria-orientation={vertical() ? 'vertical' : 'horizontal'}
      aria-expanded={!collapsed()}
      // The probe hook: a tab that cannot be hit is a tab that does not exist,
      // and that is exactly the bug this file is here to prevent.
      data-panel-tab={collapsed() ? props.axis : undefined}
    >
      <Show when={collapsed()}>
        <ExpandTab axis={props.axis} label={props.label} />
      </Show>
      <Show when={!collapsed()}>
        {/* The hairline, and the hit area that makes it findable on hover. */}
        <div
          class="absolute bg-accent opacity-0 transition-opacity group-hover:opacity-100"
          classList={{
            'inset-y-0 left-1/2 w-px -translate-x-1/2': vertical(),
            'inset-x-0 top-1/2 h-px -translate-y-1/2': !vertical(),
          }}
        />
        <div
          class="absolute opacity-0 transition-opacity group-hover:opacity-90"
          classList={{
            'h-8 w-1 rounded-full bg-accent/70': vertical(),
            'w-8 h-1 rounded-full bg-accent/70': !vertical(),
          }}
        />
      </Show>
    </div>
  )
}

/**
 * The tab a collapsed panel exposes: a chevron pointing at the panel, and its
 * name. The arrow alone was the "found it by luck" control this replaces.
 */
function ExpandTab(props: { axis: 'x' | 'right' | 'y'; label?: string }) {
  const vertical = (): boolean => props.axis !== 'y'
  // The base glyph points right, which is the direction the sidebar returns to.
  // The timeline tab is horizontal, so its glyph points up.
  const rotation = (): string => (props.axis === 'y' ? '-90deg' : '0deg')

  return (
    <div
      class="flex h-full w-full items-center justify-center gap-1.5 rounded-lg border border-line bg-raised text-muted shadow-md transition-colors hover:border-accent/50 hover:text-fg"
      classList={{ 'flex-col': vertical() }}
    >
      <svg viewBox="0 0 16 16" class="size-3.5 shrink-0" fill="currentColor" style={{ transform: `rotate(${rotation()})` }}>
        <path d="M10.2 3.3 5.5 8l4.7 4.7 1.1-1.1L7.7 8l3.6-3.6-1.1-1.1Z" />
      </svg>
      <span
        class="text-micro font-semibold uppercase tracking-[0.12em]"
        style={vertical() ? { 'writing-mode': 'vertical-rl', transform: 'rotate(180deg)' } : undefined}
      >
        {props.label}
      </span>
    </div>
  )
}
