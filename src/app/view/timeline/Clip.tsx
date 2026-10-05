/**
 * One clip on the timeline: the body, the two trim handles, and its badges.
 */

import { Show } from 'solid-js'
import { Check, Link2 } from 'lucide-solid'
import type { Clip as ClipModel, TrackId } from '../../../model/project.js'
import type { AppState } from '../../store/state.js'
import { Filmstrip } from './Filmstrip.js'
import { HANDLE } from './use-timeline-drag.js'
import { Waveform } from './Waveform.js'

export function Clip(props: {
  clip: ClipModel
  index: number
  state: AppState
  trackId: TrackId
  height: number
  start: number
}) {
  const state = props.state
  const left = () => props.start * state.zoom()
  const width = () => Math.max(0, props.clip.out - props.clip.in) * state.zoom()
  const asset = () => state.getAsset(props.clip.assetId)
  const isSelected = () => state.isSelected(props.clip.id)
  const isPrimary = () => state.primary() === props.clip.id
  const linked = () => (props.clip.linkId ? state.selectedPartner()?.linkId === props.clip.linkId : false)
  const isVideo = () => state.project.tracks.find((t) => t.id === props.trackId)?.type === 'video'

  return (
    <div
      class="group absolute top-1.5 cursor-grab overflow-hidden rounded-md border transition-shadow active:cursor-grabbing"
      classList={{
        selected: isSelected(),
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
        'background-color':
          props.clip.hidden || props.clip.muted
            ? isVideo() ? '#22222c' : '#1c2420'
            : isVideo() ? '#1b2c47' : '#16342a',
        'border-color': isSelected()
          ? 'transparent'
          : isVideo()
            ? '#2a4674'
            : '#1f5541',
      }}
      title={`${asset()?.name ?? 'missing'} — ${props.clip.in.toFixed(2)}s → ${props.clip.out.toFixed(2)}s`}
    >
      <Show when={isVideo() && asset()?.hasVideo && !props.clip.hidden}>
        <Filmstrip clip={props.clip} state={state} />
      </Show>

      <div class="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/[0.06] to-transparent" />

      <Show when={isSelected() && !isPrimary()}>
        <span
          class="pointer-events-none absolute left-1 top-1 z-30 flex size-3.5 items-center justify-center rounded-full bg-accent text-micro font-bold text-black"
          aria-label="selected"
        >
          <Check size={10} strokeWidth={3} />
        </span>
      </Show>

      <Show when={props.clip.muted && !isVideo()}>
        <span
          class="pointer-events-none absolute right-1 top-1 z-30 rounded bg-[#d29922] px-1 text-micro font-bold uppercase text-black"
          aria-label="muted"
          title="Muted — the audio is still here, it is just silent. Press M to unmute."
        >
          mute
        </span>
      </Show>
      <Show when={props.clip.hidden && isVideo()}>
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

      <Show when={!isVideo()}>
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
