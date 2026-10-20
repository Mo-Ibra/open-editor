import { createSignal, For, Show, type Component, type JSX } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowUp,
  Blend,
  Clock,
  Copy,
  Italic,
  Keyboard,
  Minus,
  Paintbrush,
  Play,
  RotateCcw,
  Sparkles,
  Trash2,
  Type,
  X,
} from 'lucide-solid'
import type { AppState } from '../../store/state.js'
import type { LayoutState } from '../../store/layout.js'
import {
  defaultTextStyle,
  TEXT_ANIMATIONS,
  TEXT_DURATION_MIN,
  TEXT_FONTS,
  TEXT_SIZE_MAX,
  TEXT_SIZE_MIN,
  type TextAlign,
  type TextAnimation,
  type TextFont,
  type TextPatch,
  type TextStyle,
} from '../../../model/text.js'
import { formatTime } from '../ui/format.js'
import { PanelToggle } from '../shell/PanelToggle.js'
import { focusTitleText } from './text-focus.js'

type Tab = 'style' | 'layout' | 'motion'

interface Preset {
  id: string
  label: string
  style: Partial<TextStyle>
  x?: number
  y?: number
}

const SWATCHES = ['#ffffff', '#0a0a0c', '#5b8cff', '#3fb950', '#ffd166', '#f2555a', '#c084fc']
const ANCHOR_ROWS = [0.16, 0.5, 0.84]
const ANCHOR_COLUMNS: { x: number; align: TextAlign; label: string }[] = [
  { x: 0.16, align: 'left', label: 'left' },
  { x: 0.5, align: 'center', label: 'centre' },
  { x: 0.84, align: 'right', label: 'right' },
]
const WEIGHTS = [400, 600, 700, 800]
const FONTS: { id: TextFont; label: string }[] = [
  { id: 'sans', label: 'Sans' },
  { id: 'serif', label: 'Serif' },
  { id: 'mono', label: 'Mono' },
  { id: 'display', label: 'Display' },
]
const TABS: { id: Tab; label: string }[] = [
  { id: 'style', label: 'Style' },
  { id: 'layout', label: 'Layout' },
  { id: 'motion', label: 'Motion' },
]
const PRESETS: Preset[] = [
  { id: 'clean', label: 'Clean', style: {} },
  {
    id: 'bold',
    label: 'Bold',
    style: { font: 'display', weight: 800, size: 0.12, shadow: true, background: null, color: '#ffffff' },
  },
  {
    id: 'caption',
    label: 'Caption',
    style: {
      size: 0.05,
      weight: 500,
      background: 'rgba(0, 0, 0, 0.62)',
      padding: 0.014,
      shadow: false,
      lineHeight: 1.3,
    },
    x: 0.5,
    y: 0.9,
  },
  {
    id: 'lower',
    label: 'Lower third',
    style: {
      size: 0.06,
      weight: 600,
      align: 'left',
      background: 'rgba(0, 0, 0, 0.58)',
      padding: 0.016,
      shadow: false,
      lineHeight: 1.25,
    },
    x: 0.18,
    y: 0.8,
  },
  {
    id: 'quote',
    label: 'Quote',
    style: {
      font: 'serif',
      italic: true,
      weight: 500,
      size: 0.07,
      lineHeight: 1.25,
      tracking: 0.01,
      shadow: false,
      background: null,
    },
    x: 0.5,
    y: 0.5,
  },
  {
    id: 'pop',
    label: 'Pop',
    style: {
      font: 'display',
      weight: 900,
      size: 0.11,
      color: '#ffd166',
      stroke: 0.004,
      strokeColor: '#0a0a0c',
      shadow: true,
      background: null,
    },
    x: 0.5,
    y: 0.5,
  },
]
const ANIMATION_META: Record<TextAnimation, { icon: Component<{ size?: number }>; blurb: string }> = {
  none: { icon: Minus, blurb: 'Static title' },
  fade: { icon: Blend, blurb: 'In and out' },
  rise: { icon: ArrowUp, blurb: 'Lifts into place' },
  pop: { icon: Sparkles, blurb: 'Springs in' },
  typewriter: { icon: Keyboard, blurb: 'Types on' },
}

function parseColor(input: string): { r: number; g: number; b: number; a: number } {
  const value = input.trim()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value)
  if (hex) {
    const digits = hex[1]!.length === 3 ? hex[1]!.split('').map((char) => char + char).join('') : hex[1]!
    return {
      r: parseInt(digits.slice(0, 2), 16),
      g: parseInt(digits.slice(2, 4), 16),
      b: parseInt(digits.slice(4, 6), 16),
      a: 1,
    }
  }
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+)\s*)?\)$/i.exec(value)
  if (rgba) {
    return {
      r: clampByte(Number(rgba[1])),
      g: clampByte(Number(rgba[2])),
      b: clampByte(Number(rgba[3])),
      a: rgba[4] === undefined ? 1 : clampAlpha(Number(rgba[4])),
    }
  }
  return { r: 255, g: 255, b: 255, a: 1 }
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)))
}

function clampAlpha(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function hexOf(color: string): string {
  const { r, g, b } = parseColor(color)
  return `#${[r, g, b].map((part) => part.toString(16).padStart(2, '0')).join('')}`
}

function alphaOf(color: string): number {
  return parseColor(color).a
}

function withAlpha(color: string, alpha: number): string {
  const { r, g, b } = parseColor(color)
  return `rgba(${r}, ${g}, ${b}, ${Number(clampAlpha(alpha).toFixed(2))})`
}

function Section(props: { title: string; right?: JSX.Element; children: JSX.Element }) {
  return (
    <section class="space-y-2">
      <div class="flex items-center justify-between gap-2">
        <span class="panel-label">{props.title}</span>
        {props.right}
      </div>
      {props.children}
    </section>
  )
}

function RangeField(props: {
  label: string
  value: number
  min: number
  max: number
  step: number
  display: string
  onInput: (value: number) => void
  onEnd: () => void
  disabled?: boolean
}) {
  return (
    <label class="block min-w-0 flex-1 space-y-1">
      <span class="flex items-baseline justify-between gap-2">
        <span class="text-tiny text-muted">{props.label}</span>
        <span class="timecode text-tiny text-faint">{props.display}</span>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        disabled={props.disabled}
        aria-label={props.label}
        class="h-1.5 w-full accent-accent disabled:opacity-35"
        onInput={(event) => props.onInput(Number(event.currentTarget.value))}
        onChange={props.onEnd}
        onPointerUp={props.onEnd}
        onKeyUp={props.onEnd}
      />
    </label>
  )
}

function Toggle(props: { label: string; on: boolean; onChange: () => void; title?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.on}
      aria-label={props.label}
      title={props.title}
      onClick={props.onChange}
      class="flex h-9 w-full items-center justify-between gap-2 rounded-lg border px-2.5 text-tiny font-medium transition-colors"
      classList={{
        'border-accent/70 bg-accent/10 text-fg': props.on,
        'border-line text-muted hover:border-line-strong hover:text-fg': !props.on,
      }}
    >
      <span>{props.label}</span>
      <span
        class="relative h-5 w-9 shrink-0 rounded-full ring-1 ring-inset ring-black/25 transition-colors"
        classList={{ 'bg-accent': props.on, 'bg-line-strong': !props.on }}
      >
        <span
          class="absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.45)] transition-transform"
          classList={{ 'translate-x-4': props.on, 'translate-x-0': !props.on }}
        />
      </span>
    </button>
  )
}

export function TextInspector(props: { state: AppState; layout: LayoutState }) {
  const state = props.state
  const clip = () => state.activeText()
  const style = () => clip()!.style
  const [tab, setTab] = createSignal<Tab>('style')
  const collapsed = () => props.layout.inspectorCollapsed()

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

  function isVisible(): boolean {
    const active = clip()
    if (!active) return false
    const at = state.playhead()
    return at >= active.start && at <= active.start + active.duration
  }

  function applyPreset(preset: Preset): void {
    set({
      style: { ...defaultTextStyle(), ...preset.style },
      ...(preset.x === undefined ? {} : { x: preset.x }),
      ...(preset.y === undefined ? {} : { y: preset.y }),
    })
  }

  function applyStyleToAll(): void {
    const active = clip()
    if (!active || state.texts().length < 2) return
    const look = { ...active.style }
    state.commit()
    for (const text of state.texts()) {
      if (text.id === active.id) continue
      state.updateText(text.id, { style: { ...look } }, { commit: false })
    }
  }

  function resetStyle(): void {
    set({ style: defaultTextStyle() })
  }

  function previewMotion(): void {
    const active = clip()
    if (!active) return
    state.seek(Math.max(0, active.start))
    if (!state.playing()) void state.togglePlay()
  }

  function duplicate(): void {
    state.duplicateActiveText()
    focusTitleText()
  }

  function setBackground(next: string | null, commit = true): void {
    set({ style: { background: next } }, commit)
  }

  return (
    <Show when={clip()}>
      <Show
        when={!collapsed()}
        fallback={
          <aside
            class="flex w-9 shrink-0 flex-col border-l border-line bg-panel"
            data-title-inspector
            data-title-inspector-collapsed
            aria-label="Title settings (collapsed)"
          >
            <button
              type="button"
              onClick={() => props.layout.toggleInspector()}
              class="flex h-full w-full flex-col items-center gap-2 py-2 text-muted transition-colors hover:bg-raised hover:text-fg"
              title="Expand title settings"
              aria-label="Expand title settings"
              data-panel-toggle="title-collapsed"
            >
              <Type size={14} class="text-accent" />
              <span
                class="text-micro font-semibold uppercase tracking-[0.12em]"
                style={{ 'writing-mode': 'vertical-rl', transform: 'rotate(180deg)' }}
              >
                Title
              </span>
              <svg viewBox="0 0 16 16" class="mt-auto size-3" fill="currentColor" aria-hidden="true">
                <path d="M10.2 3.3 5.5 8l4.7 4.7 1.1-1.1L7.7 8l3.6-3.6-1.1-1.1Z" />
              </svg>
            </button>
          </aside>
        }
      >
        <aside
          class="flex shrink-0 flex-col border-l border-line bg-panel text-mini text-fg"
          style={{ width: props.layout.inspectorTrack() }}
          data-title-inspector
          aria-label="Title settings"
        >
          <header class="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
            <span class="grid size-6 shrink-0 place-items-center rounded-md bg-accent/15 text-accent">
              <Type size={14} />
            </span>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5">
                <span class="text-small font-semibold">Title</span>
                <span class="rounded-full border border-line bg-raised px-1.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-faint">
                  {state.texts().length} {state.texts().length === 1 ? 'layer' : 'layers'}
                </span>
              </div>
              <div class="timecode truncate text-tiny text-muted">
                {formatTime(clip()!.start)} – {formatTime(clip()!.start + clip()!.duration)}
              </div>
            </div>
            <PanelToggle
              panel="title"
              collapsed={collapsed()}
              onToggle={() => props.layout.toggleInspector()}
              dir="right"
            />
            <button
              type="button"
              class="icon-btn"
              onClick={() => state.setActiveText(null)}
              title="Close title settings"
              aria-label="Close title settings"
            >
              <X size={15} />
            </button>
          </header>

        <div class="shrink-0 border-b border-line p-3">
          <textarea
            data-title-text
            rows={2}
            spellcheck={false}
            aria-label="Title text"
            placeholder="Type your title…"
            class="w-full resize-none rounded-md border border-line bg-bg px-2.5 py-2 text-small leading-snug text-fg outline-none placeholder:text-faint focus:border-accent"
            value={clip()!.text}
            onInput={(event) => {
              begin()
              set({ text: event.currentTarget.value }, false)
            }}
            onBlur={end}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return
              event.preventDefault()
              event.currentTarget.blur()
              state.setActiveText(null)
            }}
          />
          <div class="mt-1 flex items-center justify-between gap-2 text-tiny text-faint">
            <span>Edit the words here</span>
            <span class="timecode">{clip()!.text.length} chars</span>
          </div>
        </div>

        <Show when={!isVisible()}>
          <div class="flex shrink-0 items-center gap-2 border-b border-warn/20 bg-warn/10 px-3 py-2 text-tiny text-warn">
            <Clock size={13} class="shrink-0" />
            <span class="min-w-0 flex-1 leading-snug">This title is not under the playhead.</span>
            <button
              type="button"
              class="shrink-0 rounded border border-warn/40 px-1.5 py-0.5 text-tiny hover:bg-warn/15"
              onClick={() => state.seek(clip()!.start)}
            >
              Jump to it
            </button>
          </div>
        </Show>

        <div class="shrink-0 border-b border-line p-2">
          <div class="flex rounded-md bg-raised p-0.5" role="tablist" aria-label="Title settings sections">
            <For each={TABS}>
              {(item) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab() === item.id}
                  onClick={() => setTab(item.id)}
                  class="h-7 flex-1 rounded-[5px] text-tiny font-medium transition-colors"
                  classList={{
                    'bg-raised-2 text-fg shadow-sm': tab() === item.id,
                    'text-muted hover:text-fg': tab() !== item.id,
                  }}
                >
                  {item.label}
                </button>
              )}
            </For>
          </div>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <Show when={tab() === 'style'}>
            <div class="space-y-4">
              <Section title="Presets">
                <div class="grid grid-cols-3 gap-1">
                  <For each={PRESETS}>
                    {(preset) => (
                      <button
                        type="button"
                        title={`Apply ${preset.label} preset`}
                        aria-label={`Apply ${preset.label} preset`}
                        onClick={() => applyPreset(preset)}
                        class="group min-w-0 rounded-md border border-line bg-bg p-1 transition-colors hover:border-accent/60 hover:bg-raised"
                      >
                        <span
                          class="flex h-7 items-center justify-center overflow-hidden rounded border border-line-soft px-1 text-[13px] leading-none"
                          style={{
                            'font-family': TEXT_FONTS[preset.style.font ?? 'sans'],
                            'font-weight': preset.style.weight ?? 700,
                            'font-style': preset.style.italic ? 'italic' : 'normal',
                            color: preset.style.color ?? style().color,
                            'background-color': preset.style.background ?? 'transparent',
                          }}
                        >
                          Aa
                        </span>
                        <span class="mt-1 block truncate text-[9px] text-muted group-hover:text-fg">{preset.label}</span>
                      </button>
                    )}
                  </For>
                </div>
                <button
                  type="button"
                  disabled={state.texts().length < 2}
                  onClick={applyStyleToAll}
                  title="Copy this title's look onto every other title"
                  class="flex h-7 w-full items-center justify-center gap-1.5 rounded-md border border-line text-tiny text-muted transition-colors hover:border-line-strong hover:text-fg disabled:pointer-events-none disabled:opacity-35"
                >
                  <Paintbrush size={12} /> Apply style to all titles
                </button>
              </Section>

              <Section title="Font">
                <div class="grid grid-cols-2 gap-1">
                  <For each={FONTS}>
                    {(font) => (
                      <button
                        type="button"
                        onClick={() => set({ style: { font: font.id } })}
                        aria-pressed={style().font === font.id}
                        class="flex items-baseline justify-between gap-2 rounded-md border px-2 py-1.5 text-left transition-colors"
                        classList={{
                          'border-accent/70 bg-accent/10 text-fg': style().font === font.id,
                          'border-line text-muted hover:border-line-strong hover:text-fg': style().font !== font.id,
                        }}
                      >
                        <span
                          class="text-[17px] leading-none"
                          style={{ 'font-family': TEXT_FONTS[font.id] }}
                        >
                          Ag
                        </span>
                        <span class="text-[9px] uppercase tracking-[0.08em]">{font.label}</span>
                      </button>
                    )}
                  </For>
                </div>
              </Section>

              <Section
                title="Size"
                right={<span class="timecode text-tiny text-faint">≈ {Math.round(style().size * 1080)} px @1080</span>}
              >
                <RangeField
                  label="Size"
                  min={TEXT_SIZE_MIN}
                  max={TEXT_SIZE_MAX}
                  step={0.005}
                  value={style().size}
                  display={`${(style().size * 100).toFixed(1)}%`}
                  onInput={(value) => {
                    begin()
                    set({ style: { size: value } }, false)
                  }}
                  onEnd={end}
                />
              </Section>

              <Section title="Type">
                <div class="grid grid-cols-4 gap-1">
                  <For each={WEIGHTS}>
                    {(weight) => (
                      <button
                        type="button"
                        onClick={() => set({ style: { weight } })}
                        aria-pressed={Math.abs(style().weight - weight) < 1}
                        class="h-7 rounded-md border text-tiny transition-colors"
                        classList={{
                          'border-accent/70 bg-accent/15 text-fg': Math.abs(style().weight - weight) < 1,
                          'border-line text-muted hover:border-line-strong hover:text-fg':
                            Math.abs(style().weight - weight) >= 1,
                        }}
                        style={{ 'font-weight': weight }}
                      >
                        {weight}
                      </button>
                    )}
                  </For>
                </div>
                <div class="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => set({ style: { italic: !style().italic } })}
                    aria-pressed={style().italic}
                    class="flex h-7 items-center gap-1 rounded-md border px-2 text-tiny transition-colors"
                    classList={{
                      'border-accent/70 bg-accent/15 text-fg': style().italic,
                      'border-line text-muted hover:border-line-strong hover:text-fg': !style().italic,
                    }}
                  >
                    <Italic size={12} /> Italic
                  </button>
                  <span class="flex-1" />
                  <div class="flex overflow-hidden rounded-md border border-line">
                    <For each={['left', 'center', 'right'] as TextAlign[]}>
                      {(align) => (
                        <button
                          type="button"
                          title={align}
                          aria-label={`Align ${align}`}
                          aria-pressed={style().align === align}
                          onClick={() => set({ style: { align } })}
                          class="grid h-7 w-7 place-items-center text-muted transition-colors hover:bg-raised-2 hover:text-fg"
                          classList={{ 'bg-accent/20 text-accent': style().align === align }}
                        >
                          <Dynamic
                            component={
                              align === 'left' ? AlignLeft : align === 'center' ? AlignCenter : AlignRight
                            }
                            size={13}
                          />
                        </button>
                      )}
                    </For>
                  </div>
                </div>
              </Section>

              <Section title="Color" right={<span class="timecode text-tiny text-faint">{hexOf(style().color)}</span>}>
                <div class="flex items-center gap-2">
                  <label
                    class="relative size-8 shrink-0 cursor-pointer overflow-hidden rounded-md border border-line bg-bg"
                    title="Pick a custom color"
                  >
                    <span class="absolute inset-1 rounded-[3px]" style={{ 'background-color': style().color }} />
                    <input
                      type="color"
                      value={hexOf(style().color)}
                      aria-label="Title color"
                      class="absolute inset-0 size-full cursor-pointer opacity-0"
                      onInput={(event) => {
                        begin()
                        set({ style: { color: event.currentTarget.value } }, false)
                      }}
                      onChange={end}
                    />
                  </label>
                  <div class="flex flex-1 flex-wrap items-center gap-1.5">
                    <For each={SWATCHES}>
                      {(swatch) => (
                        <button
                          type="button"
                          title={swatch}
                          aria-label={`Set title color to ${swatch}`}
                          onClick={() => set({ style: { color: swatch } })}
                          class="size-5 rounded-full border border-line transition-transform hover:scale-110"
                          classList={{
                            'ring-2 ring-accent ring-offset-1 ring-offset-panel':
                              hexOf(style().color) === swatch,
                          }}
                          style={{ 'background-color': swatch }}
                        />
                      )}
                    </For>
                  </div>
                </div>
              </Section>

              <Section title="Background">
                <Toggle
                  label="Plate behind text"
                  on={style().background !== null}
                  onChange={() => setBackground(style().background ? null : 'rgba(0, 0, 0, 0.55)')}
                />
                <Show when={style().background}>
                  <div class="flex items-center gap-2 pt-1">
                    <label
                      class="relative size-8 shrink-0 cursor-pointer overflow-hidden rounded-md border border-line bg-bg"
                      title="Plate color"
                    >
                      <span
                        class="absolute inset-1 rounded-[3px]"
                        style={{ 'background-color': style().background ?? '#000000' }}
                      />
                      <input
                        type="color"
                        value={hexOf(style().background ?? '#000000')}
                        aria-label="Plate color"
                        class="absolute inset-0 size-full cursor-pointer opacity-0"
                        onInput={(event) => {
                          begin()
                          set(
                            {
                              style: {
                                background: withAlpha(event.currentTarget.value, alphaOf(style().background ?? '#000000')),
                              },
                            },
                            false,
                          )
                        }}
                        onChange={end}
                      />
                    </label>
                    <RangeField
                      label="Plate opacity"
                      min={0.05}
                      max={0.95}
                      step={0.01}
                      value={alphaOf(style().background ?? '#000000')}
                      display={`${Math.round(alphaOf(style().background ?? '#000000') * 100)}%`}
                      onInput={(value) => {
                        begin()
                        set({ style: { background: withAlpha(style().background ?? '#000000', value) } }, false)
                      }}
                      onEnd={end}
                    />
                  </div>
                  <RangeField
                    label="Plate padding"
                    min={0}
                    max={0.05}
                    step={0.001}
                    value={style().padding}
                    display={`${Math.round(style().padding * 1080)} px`}
                    onInput={(value) => {
                      begin()
                      set({ style: { padding: value } }, false)
                    }}
                    onEnd={end}
                  />
                </Show>
              </Section>

              <Section title="Effects">
                <Toggle
                  label="Drop shadow"
                  on={style().shadow}
                  onChange={() => set({ style: { shadow: !style().shadow } })}
                />
                <Toggle
                  label="Outline"
                  on={style().stroke > 0}
                  onChange={() => set({ style: { stroke: style().stroke > 0 ? 0 : 0.004 } })}
                />
                <Show when={style().stroke > 0}>
                  <div class="flex items-center gap-2">
                    <RangeField
                      label="Outline width"
                      min={0.001}
                      max={0.012}
                      step={0.0005}
                      value={style().stroke}
                      display={`${(style().stroke * 1080).toFixed(1)} px`}
                      onInput={(value) => {
                        begin()
                        set({ style: { stroke: value } }, false)
                      }}
                      onEnd={end}
                    />
                    <label
                      class="relative size-8 shrink-0 cursor-pointer overflow-hidden rounded-md border border-line bg-bg"
                      title="Outline color"
                    >
                      <span
                        class="absolute inset-1 rounded-[3px]"
                        style={{ 'background-color': style().strokeColor }}
                      />
                      <input
                        type="color"
                        value={hexOf(style().strokeColor)}
                        aria-label="Outline color"
                        class="absolute inset-0 size-full cursor-pointer opacity-0"
                        onInput={(event) => {
                          begin()
                          set({ style: { strokeColor: event.currentTarget.value } }, false)
                        }}
                        onChange={end}
                      />
                    </label>
                  </div>
                </Show>
              </Section>

              <Section title="Fine tune">
                <RangeField
                  label="Line height"
                  min={0.8}
                  max={2}
                  step={0.05}
                  value={style().lineHeight}
                  display={style().lineHeight.toFixed(2)}
                  onInput={(value) => {
                    begin()
                    set({ style: { lineHeight: value } }, false)
                  }}
                  onEnd={end}
                />
                <RangeField
                  label="Letter spacing"
                  min={-0.05}
                  max={0.3}
                  step={0.005}
                  value={style().tracking}
                  display={`${style().tracking.toFixed(3)} em`}
                  onInput={(value) => {
                    begin()
                    set({ style: { tracking: value } }, false)
                  }}
                  onEnd={end}
                />
              </Section>
            </div>
          </Show>

          <Show when={tab() === 'layout'}>
            <div class="space-y-4">
              <Section title="Anchor">
                <div class="grid grid-cols-3 gap-1">
                  <For each={ANCHOR_ROWS}>
                    {(y) => (
                      <For each={ANCHOR_COLUMNS}>
                        {(column) => {
                          const selected = (): boolean =>
                            Math.abs(clip()!.x - column.x) < 0.001 &&
                            Math.abs(clip()!.y - y) < 0.001 &&
                            style().align === column.align
                          return (
                            <button
                              type="button"
                              title={`Place ${column.label}, ${Math.round(y * 100)}% down`}
                              aria-label={`Place title ${column.label}, ${Math.round(y * 100)}% down`}
                              aria-pressed={selected()}
                              onClick={() => set({ x: column.x, y, style: { align: column.align } })}
                              class="grid h-10 place-items-center rounded-md border text-faint transition-colors hover:border-accent/60 hover:text-fg"
                              classList={{
                                'border-accent/70 bg-accent/15 text-accent': selected(),
                                'border-line': !selected(),
                              }}
                            >
                              <span class="size-1.5 rounded-full bg-current" />
                            </button>
                          )
                        }}
                      </For>
                    )}
                  </For>
                </div>
                <p class="text-tiny leading-snug text-faint">
                  Choosing a side also aligns the text to that side, so the whole title stays on screen. Drag it on the picture for free placement.
                </p>
              </Section>

              <Section title="Position">
                <RangeField
                  label="Horizontal"
                  min={0}
                  max={1}
                  step={0.002}
                  value={clip()!.x}
                  display={`${Math.round(clip()!.x * 100)}%`}
                  onInput={(value) => {
                    begin()
                    set({ x: value }, false)
                  }}
                  onEnd={end}
                />
                <RangeField
                  label="Vertical"
                  min={0}
                  max={1}
                  step={0.002}
                  value={clip()!.y}
                  display={`${Math.round(clip()!.y * 100)}%`}
                  onInput={(value) => {
                    begin()
                    set({ y: value }, false)
                  }}
                  onEnd={end}
                />
              </Section>

              <Section
                title="Timing"
                right={<span class="timecode text-tiny text-faint">ends {formatTime(clip()!.start + clip()!.duration)}</span>}
              >
                <div class="grid grid-cols-2 gap-2">
                  <label class="block space-y-1">
                    <span class="text-tiny text-muted">Start</span>
                    <input
                      type="number"
                      min={0}
                      step={0.1}
                      value={Number(clip()!.start.toFixed(2))}
                      aria-label="Title start time"
                      class="timecode h-8 w-full rounded-md border border-line bg-bg px-2 text-tiny outline-none focus:border-accent"
                      onChange={(event) => set({ start: Number(event.currentTarget.value) })}
                    />
                  </label>
                  <label class="block space-y-1">
                    <span class="text-tiny text-muted">Duration</span>
                    <input
                      type="number"
                      min={TEXT_DURATION_MIN}
                      step={0.1}
                      value={Number(clip()!.duration.toFixed(2))}
                      aria-label="Title duration"
                      class="timecode h-8 w-full rounded-md border border-line bg-bg px-2 text-tiny outline-none focus:border-accent"
                      onChange={(event) => set({ duration: Number(event.currentTarget.value) })}
                    />
                  </label>
                </div>
                <div class="flex gap-1">
                  <button
                    type="button"
                    onClick={() => set({ start: state.playhead() })}
                    class="h-7 flex-1 rounded-md border border-line text-tiny text-muted transition-colors hover:border-line-strong hover:text-fg"
                  >
                    Start here
                  </button>
                  <button
                    type="button"
                    disabled={state.playhead() <= clip()!.start + TEXT_DURATION_MIN}
                    onClick={() => set({ duration: Math.max(TEXT_DURATION_MIN, state.playhead() - clip()!.start) })}
                    class="h-7 flex-1 rounded-md border border-line text-tiny text-muted transition-colors hover:border-line-strong hover:text-fg disabled:pointer-events-none disabled:opacity-35"
                  >
                    End here
                  </button>
                </div>
                <p class="text-tiny leading-snug text-faint">The block in the text lane can also be dragged and trimmed.</p>
              </Section>
            </div>
          </Show>

          <Show when={tab() === 'motion'}>
            <div class="space-y-4">
              <Section title="Animation">
                <div class="grid grid-cols-2 gap-1">
                  <For each={TEXT_ANIMATIONS}>
                    {(animation) => (
                      <button
                        type="button"
                        onClick={() => set({ animation: animation.id })}
                        aria-pressed={clip()!.animation === animation.id}
                        class="flex min-w-0 items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors"
                        classList={{
                          'border-accent/70 bg-accent/10 text-fg': clip()!.animation === animation.id,
                          'border-line text-muted hover:border-line-strong hover:text-fg':
                            clip()!.animation !== animation.id,
                        }}
                      >
                        <span class="grid size-7 shrink-0 place-items-center rounded-md bg-raised-2 text-faint">
                          <Dynamic component={ANIMATION_META[animation.id].icon} size={14} />
                        </span>
                        <span class="min-w-0">
                          <span class="block truncate text-tiny font-medium">{animation.label}</span>
                          <span class="block truncate text-[10px] text-faint">{ANIMATION_META[animation.id].blurb}</span>
                        </span>
                      </button>
                    )}
                  </For>
                </div>
              </Section>

              <Show when={clip()!.animation !== 'none'}>
                <Section title="Timing">
                  <RangeField
                    label="In duration"
                    min={0.1}
                    max={2}
                    step={0.05}
                    value={clip()!.animationDuration}
                    display={`${clip()!.animationDuration.toFixed(2)}s`}
                    onInput={(value) => {
                      begin()
                      set({ animationDuration: value }, false)
                    }}
                    onEnd={end}
                  />
                  <p class="text-tiny leading-snug text-faint">
                    {clip()!.animation === 'fade'
                      ? 'Fade uses the same duration at both the start and the end.'
                      : 'The title animates in over this duration.'}
                  </p>
                </Section>
              </Show>

              <button
                type="button"
                onClick={previewMotion}
                class="flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-accent text-tiny font-semibold text-white transition-colors hover:bg-[#6d9aff]"
              >
                <Play size={13} /> Play from the title's start
              </button>
            </div>
          </Show>
        </div>

        <footer class="flex shrink-0 items-center gap-1.5 border-t border-line p-2">
          <button
            type="button"
            onClick={duplicate}
            class="btn h-8 flex-1 justify-center !px-2 text-tiny"
            title="Duplicate this title"
          >
            <Copy size={13} /> Duplicate
          </button>
          <button
            type="button"
            onClick={resetStyle}
            class="icon-btn"
            title="Reset this title's look"
            aria-label="Reset this title's look"
          >
            <RotateCcw size={14} />
          </button>
          <button
            type="button"
            disabled={state.texts().length < 2}
            onClick={applyStyleToAll}
            class="icon-btn"
            title="Apply this style to all titles"
            aria-label="Apply this style to all titles"
          >
            <Paintbrush size={14} />
          </button>
          <button
            type="button"
            onClick={() => state.removeActiveText()}
            class="btn h-8 !px-2 text-tiny text-danger! hover:border-danger/60 hover:bg-danger/10"
            title="Delete this title"
          >
            <Trash2 size={13} /> Delete
          </button>
          </footer>
        </aside>
      </Show>
    </Show>
  )
}
