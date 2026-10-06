/**
 * The title inspector: one bar that edits whatever title is selected.
 *
 * It floats over the picture rather than living in a side panel on purpose. A
 * title is judged by how it sits on the frame, and a control strip that shares
 * the frame's bottom edge lets you drag a card to the corner and set its size
 * without your eye ever leaving the picture.
 *
 * Every edit goes through the same `updateText` the drag uses, so the bar, the
 * canvas drag, and the timeline lane are three input devices for one operation
 * — there is no "inspector mode" that behaves differently.
 *
 * Gesture coalescing: sliders and the text field commit history once, on the
 * first change of a gesture, and then apply with `commit: false` until the
 * gesture ends. Without it every pixel of a slider drag is an undo step, and a
 * sentence is forty of them.
 */

import { For, Show, type JSX } from 'solid-js'
import type { AppState } from '../../store/state.js'
import {
  TEXT_ANIMATIONS,
  TEXT_DURATION_MIN,
  TEXT_SIZE_MAX,
  TEXT_SIZE_MIN,
  type TextAlign,
  type TextFont,
  type TextPatch,
} from '../../../model/text.js'

const SWATCHES = ['#ffffff', '#0a0a0c', '#5b8cff', '#3fb950', '#ffd166', '#f2555a', '#c084fc']
const GRID = [0.16, 0.5, 0.84]
const FONTS: { id: TextFont; label: string }[] = [
  { id: 'sans', label: 'Sans' },
  { id: 'serif', label: 'Serif' },
  { id: 'mono', label: 'Mono' },
  { id: 'display', label: 'Display' },
]

function label(text: string): JSX.Element {
  return <span class="text-[9px] font-medium uppercase tracking-[0.09em] text-faint">{text}</span>
}

export function TextInspector(props: { state: AppState }) {
  const state = props.state
  const clip = () => state.activeText()
  const style = () => clip()!.style

  // One history entry per gesture, not per event. `begin` fires on the first
  // change after a pause; `end` on release/blur.
  let gesture = false

  function set(patch: TextPatch, commit = true): void {
    const active = clip()
    if (active) state.updateText(active.id, patch, { commit })
  }

  function begin(): void {
    if (gesture) return
    state.commit()
    gesture = true
  }

  function end(): void {
    gesture = false
  }

  return (
    <Show when={clip()}>
      <div class="pointer-events-auto absolute inset-x-2 bottom-2 z-30 flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg border border-line bg-raised/95 px-2.5 py-2 text-mini text-fg shadow-[var(--shadow-pop)] backdrop-blur">
        <span class="flex items-center gap-1.5 pr-0.5">
          <span class="size-2 rounded-full bg-accent" />
          <span class="font-medium">Title</span>
        </span>

        <textarea
          rows={1}
          spellcheck={false}
          class="h-7 w-40 resize-none rounded border border-line bg-bg px-2 py-1 text-mini outline-none focus:border-accent"
          value={clip()!.text}
          onInput={(e) => {
            begin()
            set({ text: e.currentTarget.value }, false)
          }}
          onBlur={end}
        />

        <div class="flex items-center overflow-hidden rounded border border-line">
          <For each={FONTS}>
            {(font) => (
              <button
                type="button"
                class="h-7 px-2 text-mini hover:bg-raised-2"
                classList={{ 'bg-accent text-bg': style().font === font.id }}
                onClick={() => set({ style: { font: font.id } })}
              >
                {font.label}
              </button>
            )}
          </For>
        </div>

        <div class="flex items-center gap-1.5">
          {label('Size')}
          <input
            type="range"
            min={TEXT_SIZE_MIN}
            max={TEXT_SIZE_MAX}
            step={0.005}
            value={style().size}
            class="w-20 accent-accent"
            onInput={(e) => {
              begin()
              set({ style: { size: Number(e.currentTarget.value) } }, false)
            }}
            onChange={end}
            onPointerUp={end}
            onKeyUp={end}
          />
        </div>

        <div class="flex items-center overflow-hidden rounded border border-line">
          <button
            type="button"
            class="h-7 w-7 font-bold hover:bg-raised-2"
            classList={{ 'bg-accent text-bg': style().weight >= 600 }}
            onClick={() => set({ style: { weight: style().weight >= 600 ? 400 : 800 } })}
          >
            B
          </button>
          <button
            type="button"
            class="h-7 w-7 italic hover:bg-raised-2"
            classList={{ 'bg-accent text-bg': style().italic }}
            onClick={() => set({ style: { italic: !style().italic } })}
          >
            I
          </button>
        </div>

        <div class="flex items-center overflow-hidden rounded border border-line">
          <For each={['left', 'center', 'right'] as TextAlign[]}>
            {(align) => (
              <button
                type="button"
                class="h-7 w-7 text-mini hover:bg-raised-2"
                classList={{ 'bg-accent text-bg': style().align === align }}
                onClick={() => set({ style: { align } })}
              >
                {align === 'left' ? '⟸' : align === 'center' ? '≡' : '⟹'}
              </button>
            )}
          </For>
        </div>

        <span class="h-5 w-px bg-line" />

        <div class="flex items-center gap-1.5">
          {label('Color')}
          <input
            type="color"
            value={style().color}
            class="h-6 w-6 cursor-pointer rounded border border-line bg-bg p-0"
            onInput={(e) => {
              begin()
              set({ style: { color: e.currentTarget.value } }, false)
            }}
            onChange={end}
          />
          <div class="flex items-center gap-0.5">
            <For each={SWATCHES}>
              {(swatch) => (
                <button
                  type="button"
                  title={swatch}
                  class="size-4 rounded-full border border-line"
                  style={{ 'background-color': swatch }}
                  onClick={() => set({ style: { color: swatch } })}
                />
              )}
            </For>
          </div>
        </div>

        <button
          type="button"
          class="h-7 rounded border px-2 text-mini hover:bg-raised-2"
          classList={{
            'border-accent text-accent': style().background !== null,
            'border-line text-muted': style().background === null,
          }}
          onClick={() => set({ style: { background: style().background ? null : 'rgba(0,0,0,0.55)' } })}
          title="Plate behind the text"
        >
          Plate
        </button>
        <Show when={style().background}>
          <input
            type="color"
            value={style().background ?? '#000000'}
            class="h-6 w-6 cursor-pointer rounded border border-line bg-bg p-0"
            onInput={(e) => {
              begin()
              set({ style: { background: e.currentTarget.value } }, false)
            }}
            onChange={end}
          />
        </Show>

        <button
          type="button"
          class="h-7 rounded border px-2 text-mini hover:bg-raised-2"
          classList={{ 'border-accent text-accent': style().shadow, 'border-line text-muted': !style().shadow }}
          onClick={() => set({ style: { shadow: !style().shadow } })}
        >
          Shadow
        </button>

        <span class="h-5 w-px bg-line" />

        <div class="flex items-center gap-1.5">
          {label('Motion')}
          <select
            class="h-7 rounded border border-line bg-bg px-1 text-mini outline-none focus:border-accent"
            value={clip()!.animation}
            onChange={(e) => set({ animation: e.currentTarget.value as TextPatch['animation'] })}
          >
            <For each={TEXT_ANIMATIONS}>{(anim) => <option value={anim.id}>{anim.label}</option>}</For>
          </select>
        </div>
        <Show when={clip()!.animation !== 'none'}>
          <div class="flex items-center gap-1.5">
            {label('Speed')}
            <input
              type="range"
              min={0.1}
              max={2}
              step={0.05}
              value={clip()!.animationDuration}
              class="w-16 accent-accent"
              onInput={(e) => {
                begin()
                set({ animationDuration: Number(e.currentTarget.value) }, false)
              }}
              onChange={end}
              onPointerUp={end}
              onKeyUp={end}
            />
          </div>
        </Show>

        <span class="h-5 w-px bg-line" />

        <div class="flex items-center gap-1.5">
          {label('Timing')}
          <input
            type="number"
            min={0}
            step={0.1}
            value={Number(clip()!.start.toFixed(2))}
            class="h-7 w-14 rounded border border-line bg-bg px-1 text-mini outline-none focus:border-accent"
            onChange={(e) => set({ start: Number(e.currentTarget.value) })}
          />
          <span class="text-faint">→</span>
          <input
            type="number"
            min={TEXT_DURATION_MIN}
            step={0.1}
            value={Number(clip()!.duration.toFixed(2))}
            class="h-7 w-14 rounded border border-line bg-bg px-1 text-mini outline-none focus:border-accent"
            onChange={(e) => set({ duration: Number(e.currentTarget.value) })}
          />
        </div>

        {/* Nine-way placement. The centre dot is the anchor the drag honours. */}
        <div class="grid grid-cols-3 gap-0.5" title="Position">
          <For each={GRID}>
            {(y) => (
              <For each={GRID}>
                {(x) => (
                  <button
                    type="button"
                    class="size-2.5 rounded-[1px] border border-line hover:border-accent"
                    classList={{
                      'bg-accent border-accent':
                        Math.abs(clip()!.x - x) < 0.001 && Math.abs(clip()!.y - y) < 0.001,
                    }}
                    onClick={() => set({ x, y })}
                  />
                )}
              </For>
            )}
          </For>
        </div>

        <div class="ml-auto flex items-center gap-1">
          <button
            type="button"
            class="h-7 rounded border border-line px-2 text-mini hover:bg-raised-2"
            onClick={() => state.duplicateActiveText()}
          >
            Duplicate
          </button>
          <button
            type="button"
            class="h-7 rounded border border-danger/60 px-2 text-mini text-danger hover:bg-danger/10"
            onClick={() => state.removeActiveText()}
          >
            Remove
          </button>
        </div>
      </div>
    </Show>
  )
}
