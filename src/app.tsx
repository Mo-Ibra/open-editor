/**
 * App shell: layout, global keyboard, drag-and-drop, notices.
 */

import { createEffect, onCleanup, onMount, For, Show } from 'solid-js'
import { AssetBin } from './ui/AssetBin.js'
import { Preview } from './ui/Preview.js'
import { Timeline } from './ui/Timeline.js'
import { ExportPanel } from './ui/ExportPanel.js'
import { createAppState } from './state.js'
import { dump, log } from './debug.js'

export function App() {
  const state = createAppState()

  function onKeyDown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement
    // Never steal keys from a text field.
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return
    // A focused button already has its own space/enter behaviour. Handling it
    // here too means one keypress both activates the button and toggles play.
    if (target.tagName === 'BUTTON' && (event.key === ' ' || event.key === 'Enter')) return

    switch (event.key) {
      case ' ':
        event.preventDefault()
        console.log('[transport] space -> togglePlay', {
          video: state.project.video.length,
          audio: state.project.audio.length,
          duration: state.duration(),
          wasPlaying: state.playing(),
        })
        state.togglePlay()
        console.log('[transport] now playing:', state.playing())
        break
      case 's':
      case 'S':
        if (state.project.video.length || state.project.audio.length) state.splitAt(state.playhead())
        break
      case 'm':
      case 'M':
        state.audio.setMuted(!state.audio.isMuted)
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
      case 'z':
      case 'Z':
        if (event.metaKey || event.ctrlKey) {
          event.preventDefault()
          event.shiftKey ? state.redo() : state.undo()
        }
        break
    }
  }

  // A tab switch must not leave a decode in flight drawing into a dead canvas.
  onMount(() => {
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('beforeunload', () => state.library.dispose())
  })
  onCleanup(() => window.removeEventListener('keydown', onKeyDown))

  // The frame cache is only valid for the media it holds.
  createEffect(() => {
    state.project.video
    state.project.audio
    state.frameCache.clear()
  })

  return (
    <div
      class="app"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('video/') || /video|\.mov$/i.test(f.name))
        if (files.length) void state.addFiles(files)
      }}
    >
      <AssetBin state={state} />

      <main>
        <Preview state={state} />
        <ExportPanel state={state} />
        <Timeline state={state} />
      </main>

      <Show when={state.notices().length > 0}>
        <div class="notices">
          <For each={state.notices()}>
            {(notice) => (
              <div class={`notice ${notice.kind}`} onClick={() => undefined}>
                {notice.text}
              </div>
            )}
          </For>
        </div>
      </Show>

      <footer class="status">
        <button
          class="ghost"
          onClick={() => {
            const text = dump()
            void navigator.clipboard?.writeText(text)
            log.info('log dump copied to clipboard', { lines: text.split('\n').length })
          }}
        >
          copy logs
        </button>
        <span>
          <kbd>space</kbd> play · <kbd>S</kbd> split · <kbd>⌫</kbd> delete · <kbd>←</kbd>
          <kbd>→</kbd> step · <kbd>⌘Z</kbd> undo
        </span>
        <span class="spacer" />
        <Show when={state.canUndo()}>
          <span class="dim">edited</span>
        </Show>
      </footer>
    </div>
  )
}
