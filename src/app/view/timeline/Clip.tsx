/**
 * One clip on the timeline: the body, the two trim handles, and its badges.
 *
 * Position comes from the *derived* start, never a stored value, so a clip
 * cannot drift out of order however it was edited (docs/data-model.md).
 *
 * The `data-*` attributes are the timeline's gesture vocabulary: the drag
 * controller reads `data-handle`, `data-index`, `data-clip-index` and
 * `data-clip-id` off the event target to decide what a press means. They are
 * the contract between this component and `use-timeline-drag`.
 */

import { Show } from 'solid-js'
import { Check, Link2 } from 'lucide-solid'
import type { Clip as ClipModel, Lane } from '../../../model/project.js'
import type { AppState } from '../../store/state.js'
import { Filmstrip } from './Filmstrip.js'
import { HANDLE } from './use-timeline-drag.js'
import { Waveform } from './Waveform.js'

export function Clip(props: {
  clip: ClipModel
  index: number
  state: AppState
  lane: Lane
  height: number
  /**
   * This clip's timeline start, in seconds.
   *
   * Passed in rather than asked for. `Clip` used to call
   * `state.clipRect(lane, index)` for itself, and each of those summed the lane
   * from zero — so a repaint cost O(n²) and ran on every drag frame. The lane
   * passes one memoised array to all of its clips instead (see `Lane.tsx`).
   */
  start: number
}) {
  const state = props.state
  // Only the zoom is per-clip; the position came down with the lane.
  const left = () => props.start * state.zoom()
  const width = () => Math.max(0, props.clip.out - props.clip.in) * state.zoom()
  const asset = () => state.getAsset(props.clip.assetId)
  const isSelected = () => state.isSelected(props.clip.id)
  const isPrimary = () => state.primary() === props.clip.id
  const linked = () => (props.clip.linkId ? state.selectedPartner()?.linkId === props.clip.linkId : false)

  return (
    <div
      class="group absolute top-1.5 cursor-grab overflow-hidden rounded-md border transition-shadow active:cursor-grabbing"
      classList={{
        selected: isSelected(),
        // Every selected clip gets a solid accent ring, so a multi-selection is
        // unmistakable at a glance. The primary clip additionally gets a white
        // ring, which is how you tell which one a solo action will hit.
        //
        // Solid colours via ring utilities. An opacity modifier written inside
        // an arbitrary shadow value is compiled by Tailwind into an opacity
        // applied to a var() reference, which is invalid CSS and silently drops
        // the whole box-shadow — the class exists, the ring does not. That is
        // why a multi-selection used to look like a single selected clip.
        //
        // (Written without a literal class name on purpose: Tailwind scans
        // comments too, so "here is the broken class" in a comment is enough to
        // generate it.)
        'ring-2 ring-accent': isSelected() && !isPrimary(),
        'ring-2 ring-accent ring-offset-1 ring-offset-[#0b0b0e]': isPrimary(),
        'border-transparent': !isSelected(),
      }}
      data-clip-index={props.index}
      data-clip-id={props.clip.id}
      style={{
        left: `${left()}px`,
        width: `${Math.max(2, width())}px`,
        height: `${props.height}px`,
        // Tint is a low-chroma wash; the waveform and the picture carry the colour.
        // A switched-off clip is desaturated as well as badged. The badge is the
        // precise statement; this is the at-a-glance one, and it has to survive
        // being glanced at rather than read.
        'background-color':
          props.clip.hidden || props.clip.muted
            ? props.lane === 'video' ? '#22222c' : '#1c2420'
            : props.lane === 'video' ? '#1b2c47' : '#16342a',
        'border-color': isSelected()
          ? 'transparent'
          : props.lane === 'video'
            ? '#2a4674'
            : '#1f5541',
      }}
      title={`${asset()?.name ?? 'missing'} — ${props.clip.in.toFixed(2)}s → ${props.clip.out.toFixed(2)}s`}
    >
      {/* The picture, tiled across the clip. Skipped while hidden, so a hidden
          clip really does read as black rather than showing the frame anyway. */}
      <Show when={props.lane === 'video' && asset()?.hasVideo && !props.clip.hidden}>
        <Filmstrip clip={props.clip} state={state} />
      </Show>

      {/* A shallow top-light, so a flat tint reads as a surface instead of a
          rectangle of colour. Purely decorative and behind every control. */}
      <div class="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/[0.06] to-transparent" />

      {/* A tick on every selected clip but the primary, so a group selection
          reads as a group even when the rings are only a couple of pixels. */}
      <Show when={isSelected() && !isPrimary()}>
        <span
          class="pointer-events-none absolute left-1 top-1 z-30 flex size-3.5 items-center justify-center rounded-full bg-accent text-micro font-bold text-black"
          aria-label="selected"
        >
          <Check size={10} strokeWidth={3} />
        </span>
      </Show>

      {/* Muting is invisible on a waveform otherwise: the peaks just get
          dimmer, which reads as "quieter", not "muted". The same is true of
          hiding, and worse: a hidden video clip is a black rectangle with nothing
          in it to hint that it was ever anything else.

          So both flags get a badge that is visible *without* selecting the clip.
          Pressing M and then hunting for evidence is how a user concludes the
          key did nothing. The word is spelled out — "mute" and "hide" — because
          an icon alone is a thing to be learned, and these are the two states a
          user is most likely to forget they set. */}
      <Show when={props.clip.muted && props.lane === 'audio'}>
        <span
          class="pointer-events-none absolute right-1 top-1 z-30 rounded bg-[#d29922] px-1 text-micro font-bold uppercase text-black"
          aria-label="muted"
          title="Muted — the audio is still here, it is just silent. Press M to unmute."
        >
          mute
        </span>
      </Show>
      <Show when={props.clip.hidden && props.lane === 'video'}>
        <span
          class="pointer-events-none absolute right-1 top-1 z-30 rounded bg-[#6c6f8a] px-1 text-micro font-bold uppercase text-black"
          aria-label="hidden"
          title="Hidden — this clip is black in the preview and in the export. Press M to show it."
        >
          hide
        </span>
      </Show>

      <div
        class="absolute inset-y-0 left-0 z-20 cursor-ew-resize bg-white/0 transition-colors group-hover:bg-white/10"
        style={{ width: `${HANDLE}px` }}
        data-handle="in"
        data-index={props.index}
      />

      <Show when={props.lane === 'audio'}>
        <Waveform clip={props.clip} state={state} />
      </Show>

      <span class="pointer-events-none absolute left-2 top-1 z-10 max-w-[calc(100%-34px)] truncate text-tiny text-fg/90 [text-shadow:0_1px_2px_#000a]">
        {asset()?.name ?? '?'}
      </span>

      <Show when={linked()}>
        <span
          class="pointer-events-none absolute right-1.5 top-0.5 z-10 text-micro text-fg/60"
          title="Linked to its pair — edits apply to both"
        >
          <Link2 size={11} />
        </span>
      </Show>

      <div
        class="absolute inset-y-0 right-0 z-20 cursor-ew-resize bg-white/0 transition-colors group-hover:bg-white/10"
        style={{ width: `${HANDLE}px` }}
        data-handle="out"
        data-index={props.index}
      />
    </div>
  )
}
