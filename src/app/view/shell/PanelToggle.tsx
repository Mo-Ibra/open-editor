/**
 * The button that collapses a panel.
 *
 * This exists because the panels were already collapsible — by double-clicking
 * the 1px resizer hairline — and the feature was effectively invisible. A
 * gesture that is only discoverable by hovering a hairline and double-clicking
 * is not a feature, it is a secret, and a secret in a layout control is a
 * support question waiting to happen.
 *
 * So: the drag handle stays for resizing, and this says so out loud.
 */

/** The path points right, so every state is a rotation from there. */
const ROTATION: Record<'left' | 'right' | 'up' | 'down', [open: number, collapsed: number]> = {
  // A right-hand panel collapses toward the right, so its open arrow points
  // right and its collapsed arrow points back toward the panel.
  right: [0, 180],
  left: [180, 0],
  down: [90, 270],
  up: [270, 90],
}

export function PanelToggle(props: {
  /** What the panel is, for the accessible name. */
  panel: string
  collapsed: boolean
  onToggle: () => void
  /**
   * Why the control cannot be used, if it cannot.
   *
   * Shown in the tooltip and as the accessible description. A toggle that
   * silently refuses is worse than a disabled one, because the user cannot tell
   * it apart from a click that missed.
   */
  disabledReason?: string
  /** The direction the panel slides when it collapses. */
  dir: 'left' | 'right' | 'up' | 'down'
}) {
  const open = (): boolean => !props.collapsed
  const blocked = (): boolean => Boolean(props.disabledReason)
  const label = (): string => {
    const what = `${open() ? 'Collapse' : 'Expand'} the ${props.panel} panel`
    return blocked() ? `${what} — unavailable: ${props.disabledReason}` : what
  }
  const [openDeg, collapsedDeg] = ROTATION[props.dir]

  return (
    <button
      class="btn btn-ghost !px-1 !py-0.5"
      classList={{ 'cursor-not-allowed opacity-40': blocked() }}
      disabled={blocked()}
      onClick={props.onToggle}
      title={label()}
      aria-label={label()}
      aria-expanded={open()}
      aria-disabled={blocked() || undefined}
      data-panel-toggle={props.panel}
    >
      {/* Points the way the panel will go, and back the way it returns. One
          icon, two states, and no separate "open" glyph to keep in sync. */}
      <svg
        viewBox="0 0 16 16"
        class="size-3 transition-transform"
        style={{ transform: `rotate(${open() ? openDeg : collapsedDeg}deg)` }}
        fill="currentColor"
      >
        <path d="M5.8 3.3 10.5 8l-4.7 4.7-1.1-1.1L8.3 8 4.7 4.4l1.1-1.1Z" />
      </svg>
    </button>
  )
}
