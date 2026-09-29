/**
 * A draggable divider between two panels.
 *
 * Geometry and clamping live in `layout.ts`; this only reports the gesture, so
 * the two panels cannot disagree about what a drag means.
 *
 * Deliberately 5px wide and *visibly* draggable on hover, but only ~1px of it
 * is ever visible at rest. A fat handle eats timeline pixels; a hairline is
 * impossible to find.
 *
 * **Except when the panel is collapsed**, which is the case this file exists
 * for. A collapsed panel is 0px, so a toggle button rendered inside its header
 * is clipped out of existence — the user clicks "collapse", the panel vanishes,
 * and the one control that would bring it back is gone. (Verified with
 * `elementFromPoint`: the header button still had a 22x18 box, and nothing hit
 * it.) The only ways back were the 1px hairline and a keyboard shortcut, both
 * undiscoverable.
 *
 * So a collapsed panel gets a **visible tab on the boundary**, outside the
 * clipped panel, with a real 22px hit area. Expanded panels keep the hairline.
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
}) {
  const collapsed = (): boolean => Boolean(props.collapsed)
  return (
    <div
      class="group absolute z-30 flex items-center justify-center"
      classList={{
        'top-0 bottom-0 w-1.5 cursor-col-resize': props.axis !== 'y',
        'left-0 right-0 h-1.5 cursor-row-resize': props.axis === 'y',
        // Centred on the boundary, except when a panel has collapsed to 0px —
        // then half the handle would hang off-screen, so it sits just inside.
        '-translate-x-1/2': props.axis !== 'y' && !collapsed(),
        '-translate-y-1/2': props.axis === 'y' && !collapsed(),
        'translate-x-3': props.axis !== 'y' && collapsed(),
        // Upwards, not down. The bottom panel's boundary is the *top* of the
        // timeline, so "just inside" means inside the preview above it. Pushing
        // the tab down — the mirror of the sidebar — dropped it 12px into the
        // status footer, which is painted later and therefore covered it: a
        // button that was in the DOM, hit-testable by .click(), and unclickable
        // by a human.
        '-translate-y-6': props.axis === 'y' && collapsed(),
        // A collapsed panel has no pixels of its own, so the tab may be as big
        // as it likes. An expanded one may not, or it eats the timeline.
        'w-6': collapsed() && props.axis !== 'y',
        'h-6': collapsed() && props.axis === 'y',
      }}
      style={props.at}
      // Collapsed, this is a button and nothing else. It used to also drag, and
      // that made the two fight: `onPointerDown` expanded the panel, and the
      // `click` that followed then collapsed it again — a button that appeared
      // to do nothing. "Drag the edge to reopen" was never discoverable anyway,
      // so the drag is dropped in favour of one gesture that always works.
      onPointerDown={collapsed() ? undefined : props.onDrag}
      onDblClick={props.onToggle}
      // Always attached, and the decision made inside the handler.
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
      aria-orientation={props.axis === 'y' ? 'horizontal' : 'vertical'}
      aria-expanded={!collapsed()}
      // The probe hook: a tab that cannot be hit is a tab that does not exist,
      // and that is exactly the bug this file is here to prevent.
      data-panel-tab={collapsed() ? props.axis : undefined}
    >
      <Show when={collapsed()}>
        <ExpandTab axis={props.axis} />
      </Show>
      <Show when={!collapsed()}>
        {/* The hairline, and the hit area that makes it findable on hover. */}
        <div
          class="absolute bg-accent opacity-0 transition-opacity group-hover:opacity-100"
          classList={{
            'inset-y-0 left-1/2 w-px -translate-x-1/2': props.axis !== 'y',
            'inset-x-0 top-1/2 h-px -translate-y-1/2': props.axis === 'y',
          }}
        />
        <div
          class="absolute opacity-0 transition-opacity group-hover:opacity-90"
          classList={{
            'h-8 w-1 rounded-full bg-accent/70': props.axis !== 'y',
            'w-8 h-1 rounded-full bg-accent/70': props.axis === 'y',
          }}
        />
      </Show>
    </div>
  )
}

function ExpandTab(props: { axis: 'x' | 'right' | 'y' }) {
  return (
    <div
      class="absolute grid place-items-center rounded-md border border-line bg-raised text-muted shadow-md transition-colors hover:text-fg"
      classList={{
        'size-6': props.axis === 'y',
        'w-6 h-full': props.axis !== 'y',
      }}
      style={{ transform: `rotate(${props.axis === 'y' ? 90 : props.axis === 'right' ? 0 : 180}deg)` }}
    >
      <svg viewBox="0 0 16 16" class="size-3" fill="currentColor">
        <path d="M10.2 3.3 5.5 8l4.7 4.7 1.1-1.1L7.7 8l3.6-3.6-1.1-1.1Z" />
      </svg>
    </div>
  )
}
