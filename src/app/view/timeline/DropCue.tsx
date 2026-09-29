/**
 * The drop indicator.
 *
 * A drop target that only tints on hover makes the user guess: where will it
 * land, and what will it destroy? This answers both before the button is
 * released.
 *
 * - A **caret** at the exact, snapped landing position.
 * - A **span** showing the clip's real extent, so a long file visibly overwrites
 *   several short ones.
 * - **Colour by what will happen**: amber for insert (nothing is lost, the rest
 *   moves along), red for overwrite (material is replaced). These are the same
 *   colours the app already uses for a lossy and a safe edit.
 *
 * The duration comes from the asset, so the span is honest rather than a
 * decorative stripe.
 */

import { Show } from 'solid-js'
import type { Lane } from '../../../model/project.js'
import type { AppState } from '../../store/state.js'
import type { DropPreview } from './Lane.js'

export function DropCue(props: {
  preview: () => DropPreview | null
  lane: Lane
  state: AppState
}) {
  const left = (): number => props.state.timeToX(props.preview()?.time ?? 0)
  // A file dragged in from the desktop has no decoded duration yet, so its
  // extent is genuinely unknown. Showing a made-up width would be a lie the
  // user acts on; showing only the landing line is honest.
  const width = (): number => (props.preview()?.incoming ? 0 : (props.preview()?.duration ?? 0) * props.state.zoom())

  return (
    <Show when={props.preview()}>
      {(at) => (
        <>
          <div
            classList={{
              'pointer-events-none absolute inset-y-0 z-30': true,
              // Insert: translucent amber. Overwrite: translucent red. The
              // difference is the whole decision, so it is not a subtle one.
              'bg-[#d29922]/25': at().mode === 'insert',
              'bg-danger/25': at().mode === 'overwrite',
              // No invented extent for a file whose duration is not known yet.
              hidden: at().incoming === true,
            }}
            style={{ left: `${left()}px`, width: `${Math.max(2, width())}px` }}
            data-drop-span={at().mode}
          />
          {/* The caret: a hard edge, because "this is the line" is the message. */}
          <div
            class="pointer-events-none absolute inset-y-0 z-40 w-0.5"
            classList={{ 'bg-[#d29922]': at().mode === 'insert', 'bg-danger': at().mode === 'overwrite' }}
            style={{ left: `${left()}px` }}
            data-drop-caret={at().mode}
          >
            <span
              class="absolute -top-px left-0 rounded-sm px-1 text-[9px] font-bold uppercase leading-[13px] text-black"
              classList={{ 'bg-[#d29922]': at().mode === 'insert', 'bg-danger text-white': at().mode === 'overwrite' }}
            >
              {at().mode === 'insert' ? 'insert' : 'over'}
            </span>
          </div>
        </>
      )}
    </Show>
  )
}
