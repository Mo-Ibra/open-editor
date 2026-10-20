/**
 * The fixed header gutter on the left of the timeline.
 *
 * Track names used to live at the *end* of each lane's content, so they only
 * appeared after scrolling to the far right of the edit. A header column that
 * never scrolls horizontally is the place a track's identity belongs: the
 * rows line up with the lanes, the remove affordance is next to the name, and
 * the timeline's time origin stays at zero in the scrolling content.
 */

import { Show } from 'solid-js'
import { X } from 'lucide-solid'

export type HeaderKind = 'text' | 'video' | 'audio'

const DOT: Record<HeaderKind, string> = {
  text: 'bg-[#c084fc]',
  video: 'bg-[#4f7dd6]',
  audio: 'bg-[#3f9e78]',
}

export function TrackHeader(props: {
  kind: HeaderKind
  label: string
  height: number
  canRemove?: boolean
  onRemove?: () => void
}) {
  return (
    <div
      class="group/track flex shrink-0 items-center gap-1.5 border-b border-line-soft bg-panel/60 px-2 last:border-b-0"
      style={{ height: `${props.height}px` }}
      data-track-header={props.kind}
    >
      <span class={`size-1.5 shrink-0 rounded-full ${DOT[props.kind]}`} aria-hidden="true" />
      <span class="min-w-0 flex-1 truncate text-tiny font-semibold text-muted">{props.label}</span>
      <Show when={props.onRemove}>
        <button
          class="grid size-5 shrink-0 place-items-center rounded text-faint opacity-45 transition-all hover:bg-line hover:text-fg focus-visible:opacity-100 group-hover/track:opacity-100 disabled:cursor-not-allowed disabled:opacity-25"
          disabled={!props.canRemove}
          onPointerDown={(event) => {
            // The header sits beside `#timeline-track`, but the guard is cheap
            // and keeps a future move back inside the track from eating the click.
            event.stopPropagation()
          }}
          onClick={(event) => {
            event.stopPropagation()
            props.onRemove?.()
          }}
          aria-label={`Remove ${props.label.toLowerCase()} track`}
          title={
            props.canRemove
              ? 'Remove this track'
              : 'A track with clips must be cleared before it can be removed'
          }
        >
          <X size={11} />
        </button>
      </Show>
    </div>
  )
}
