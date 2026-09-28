/**
 * App shell: top bar, three-column body, status footer.
 *
 * The layout follows one rule: **the picture is the only thing that gets
 * colour and space.** Everything else is a low-chroma surface, because a
 * video editor that decorates its own chrome is competing with the thing the
 * user is actually looking at.
 */

import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { AssetBin } from './ui/AssetBin.js'
import { Preview } from './ui/Preview.js'
import { Timeline } from './ui/Timeline.js'
import { ExportDialog } from './ui/ExportDialog.js'
import { createAppState } from './state.js'
import { dump, log } from './debug.js'

const SHORTCUTS: [string, string][] = [
  ['space', 'play'],
  ['S', 'split'],
  ['⌫', 'delete'],
  ['←→', 'step'],
  ['D', 'overlay'],
  ['M', 'mute'],
  ['⌘Z', 'undo'],
]

export function App() {
  const state = createAppState()
  const [exportOpen, setExportOpen] = createSignal(false)

  function onKeyDown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return
    // A focused button owns space and enter; handling them here too would make
    // one keypress both activate the button and do whatever it means globally.
    if (target.tagName === 'BUTTON' && (event.key === ' ' || event.key === 'Enter')) return

    switch (event.key) {
      case ' ':
        event.preventDefault()
        void state.togglePlay()
        break
      case 's':
      case 'S':
        if (state.project.video.length || state.project.audio.length) state.splitAt(state.playhead())
        break
      case 'Backspace':
      case 'Delete':
        event.preventDefault()
        state.deleteSelected()
        break
      case 'ArrowLeft':
        event.preventDefault()
        state.step(event.shiftKey ? -10 : -1)
        break
      case 'ArrowRight':
        event.preventDefault()
        state.step(event.shiftKey ? 10 : 1)
        break
      case 'Home':
        state.seek(0)
        break
      case 'End':
        state.seek(state.duration())
        break
      case 'm':
      case 'M':
        state.audio.setMuted(!state.audio.isMuted)
        break
      case 'z':
      case 'Z':
        if (event.metaKey || event.ctrlKey) {
          event.preventDefault()
          event.shiftKey ? state.redo() : state.undo()
        }
        break
    }
  }

  onMount(() => window.addEventListener('keydown', onKeyDown))
  onCleanup(() => {
    window.removeEventListener('keydown', onKeyDown)
    state.library.dispose()
  })

  // Cached frames belong to the media they were decoded from.
  createEffect(() => {
    state.project.video
    state.project.audio
    state.frameCache.clear()
  })

  function onDrop(event: DragEvent): void {
    const files = [...(event.dataTransfer?.files ?? [])]
    if (files.length) void state.addFiles(files)
  }

  return (
    <div class="flex h-full flex-col bg-bg text-[13px] text-fg" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      {/* ---- top bar ---- */}
      <header class="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-panel px-3">
        <div class="flex items-center gap-2 pr-1">
          <span class="grid size-6 place-items-center rounded-[5px] bg-accent text-[11px] font-bold text-white">oe</span>
          <span class="text-[13px] font-semibold tracking-tight">open-editor</span>
        </div>

        <span class="h-5 w-px bg-line" />

        <div class="flex min-w-0 items-center gap-3 text-muted">
          <span class="timecode text-[11px]">
            {state.project.video.length} video · {state.project.audio.length} audio
          </span>
          <Show when={state.canUndo()}>
            <span class="rounded-full border border-line bg-raised px-1.5 py-px text-[10px]">edited</span>
          </Show>
        </div>

        <div class="flex-1" />

        <div class="flex items-center gap-1.5">
          <Show when={state.notices().length > 0}>
            <span class="size-1.5 rounded-full bg-warn" title={state.notices().at(-1)?.text} />
          </Show>
          <button
            class="btn"
            onClick={() => {
              const text = dump()
              void navigator.clipboard?.writeText(text)
              log.info('log dump copied', { lines: text.split('\n').length })
            }}
            title="Copy the last 400 log lines to the clipboard"
          >
            logs
          </button>
          <button class="btn btn-primary" onClick={() => setExportOpen(true)} disabled={!state.project.video.length}>
            Export
          </button>
        </div>
      </header>

      {/* ---- body ---- */}
      <div class="grid min-h-0 flex-1 grid-cols-[236px_minmax(0,1fr)]">
        <AssetBin state={state} />
        <main class="grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto]">
          <Preview state={state} />
        </main>
      </div>

      {/* ---- timeline ---- */}
      <Timeline state={state} />

      {/* ---- status ---- */}
      <footer class="flex h-7 shrink-0 items-center gap-3 border-t border-line bg-panel px-3 text-[10.5px] text-muted">
        <For each={SHORTCUTS}>
          {([key, what]) => (
            <span class="flex items-center gap-1">
              <kbd class="rounded border border-line bg-raised px-1 font-mono text-[9.5px] leading-[14px]">{key}</kbd>
              {what}
            </span>
          )}
        </For>
      </footer>

      <Show when={exportOpen()}>
        <ExportDialog state={state} onClose={() => setExportOpen(false)} />
      </Show>

      {/* ---- notices ---- */}
      <div class="pointer-events-none fixed right-3 bottom-16 z-50 flex w-[min(380px,calc(100vw-24px))] flex-col gap-1.5">
        <For each={state.notices()}>
          {(notice) => (
            <div
              class={`pointer-events-auto rounded-md border border-l-2 bg-raised/95 px-3 py-2 text-[12px] shadow-lg shadow-black/40 backdrop-blur ${
                notice.kind === 'error'
                  ? 'border-l-danger'
                  : notice.kind === 'warn'
                    ? 'border-l-warn'
                    : 'border-l-accent'
              }`}
            >
              {notice.text}
            </div>
          )}
        </For>
      </div>
    </div>
  )
}