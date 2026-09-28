/**
 * The app shell: top bar, resizable body, status footer, notices.
 *
 * Deliberately thin. Everything that has a *decision* in it lives elsewhere —
 * shortcuts in `shortcuts.ts`, the context menu in `menu-items.ts`, panel
 * geometry in `layout.ts`, state in `state.ts`. What is left here is the wiring
 * and the markup, and it is worth being able to read the whole file to know
 * what the app is made of.
 *
 * The visual rule: **the picture is the only thing that gets colour and
 * space.** Every other surface is low-chroma and near-neutral, because an editor
 * that decorates its own chrome is competing with the thing the user is looking
 * at.
 */

import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'

import { AssetBin } from '../ui/AssetBin.js'
import { ContextMenu, createContextMenu } from '../ui/ContextMenu.js'
import { ExportDialog } from '../ui/ExportDialog.js'
import { Preview } from '../ui/Preview.js'
import { Resizer } from '../ui/Resizer.js'
import { Timeline } from '../ui/Timeline.js'

import { dump, log } from '../dev/debug.js'
import { createKeyHandler, shortcutLegend } from './keyboard.js'
import { createLayout } from './layout.js'
import { menuItems } from './menu-items.js'
import { createShortcuts, suppressNativeMenu } from './shortcuts.js'
import { createAppState } from './state.js'

export function App() {
  const state = createAppState()
  const layout = createLayout()
  const menu = createContextMenu()
  const [exportOpen, setExportOpen] = createSignal(false)

  const copyLogs = (): void => {
    const text = dump()
    void navigator.clipboard?.writeText(text)
    log.info('log dump copied', { lines: text.split('\n').length })
  }

  // One list, two consumers: the key handler and the footer legend. Deriving
  // both from it is what stops the legend advertising keys that do nothing.
  const shortcuts = createShortcuts({ state, closeMenu: menu.hide })
  const legend = createMemo(() => shortcutLegend(shortcuts))

  // Built ONCE. Calling createKeyHandler again for the removal would hand
  // removeEventListener a different function object, silently fail to unregister
  // the first, and leave a second live copy of the handler on the window.
  const onKeyDown = createKeyHandler(shortcuts)

  onMount(() => {
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('contextmenu', suppressNativeMenu, { capture: true })
  })
  onCleanup(() => {
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('contextmenu', suppressNativeMenu, { capture: true })
    state.library.dispose()
  })

  // Cached frames belong to the media they were decoded from, so any change to
  // the lanes invalidates the cache.
  createEffect(() => {
    state.project.video
    state.project.audio
    state.frameCache.clear()
  })

  const onDrop = (event: DragEvent): void => {
    const files = [...(event.dataTransfer?.files ?? [])]
    if (files.length) void state.addFiles(files)
  }

  return (
    <div
      class="flex h-full flex-col bg-bg text-[13px] text-fg"
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <TopBar state={state} onExport={() => setExportOpen(true)} onCopyLogs={copyLogs} />

      <div
        class="relative grid min-h-0 flex-1"
        style={{ 'grid-template-columns': `${layout.sidebarTrack()} minmax(0, 1fr)` }}
      >
        <div class="relative min-h-0 min-w-0 overflow-hidden">
          <AssetBin state={state} menu={menu} />
        </div>

        {/* Drag to resize, double-click to collapse. `at` is the boundary. */}
        <Resizer
          axis="x"
          at={{ left: layout.sidebarTrack() }}
          onDrag={(e) => layout.beginSidebarDrag(e)}
          onToggle={() => layout.toggleSidebar()}
          collapsed={layout.sidebarCollapsed()}
          title="Drag to resize · double-click to collapse"
        />

        <main
          class="grid min-h-0 min-w-0"
          style={{ 'grid-template-rows': `minmax(0, 1fr) ${layout.timelineTrack()}` }}
        >
          <Preview state={state} menu={menu} />

          <div class="relative min-h-0 min-w-0 overflow-hidden">
            <Timeline state={state} menu={menu} />
            <Resizer
              axis="y"
              at={{ top: '0px' }}
              onDrag={(e) => layout.beginTimelineDrag(e)}
              onToggle={() => layout.toggleTimeline()}
              collapsed={layout.timelineCollapsed()}
              title="Drag to resize · double-click to collapse"
            />
          </div>
        </main>
      </div>

      <StatusFooter rows={legend()} />

      <ContextMenu state={menu} items={() => menuItems(state, menu, layout)} />

      <Show when={exportOpen()}>
        <ExportDialog state={state} onClose={() => setExportOpen(false)} />
      </Show>

      <Notices notices={state.notices()} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shell pieces
//
// Plain components rather than inline JSX, so each region's markup can be read
// on its own and none of them can grow a decision.
// ---------------------------------------------------------------------------

function TopBar(props: {
  state: ReturnType<typeof createAppState>
  onExport: () => void
  onCopyLogs: () => void
}) {
  const state = props.state
  return (
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
        <button class="btn" onClick={props.onCopyLogs} title="Copy the last 400 log lines to the clipboard">
          logs
        </button>
        <button
          class="btn btn-primary"
          onClick={props.onExport}
          disabled={!state.project.video.length}
          title={state.project.video.length ? 'Export the timeline' : 'Add a video clip first'}
        >
          Export
        </button>
      </div>
    </header>
  )
}

function StatusFooter(props: { rows: { hint: string; label: string }[] }) {
  return (
    <footer class="flex h-7 shrink-0 items-center gap-3 border-t border-line bg-panel px-3 text-[10.5px] text-muted">
      <For each={props.rows}>
        {(row) => (
          <span class="flex items-center gap-1">
            <kbd class="rounded border border-line bg-raised px-1 font-mono text-[9.5px] leading-[14px]">{row.hint}</kbd>
            {row.label}
          </span>
        )}
      </For>
    </footer>
  )
}

const NOTICE_BORDER = {
  error: 'border-l-danger',
  warn: 'border-l-warn',
  info: 'border-l-accent',
} as const

function Notices(props: { notices: readonly { kind: keyof typeof NOTICE_BORDER; text: string }[] }) {
  return (
    <div class="pointer-events-none fixed right-3 bottom-16 z-50 flex w-[min(380px,calc(100vw-24px))] flex-col gap-1.5">
      <For each={props.notices}>
        {(notice) => (
          <div
            class={`pointer-events-auto rounded-md border border-l-2 bg-raised/95 px-3 py-2 text-[12px] shadow-lg shadow-black/40 backdrop-blur ${NOTICE_BORDER[notice.kind]}`}
          >
            {notice.text}
          </div>
        )}
      </For>
    </div>
  )
}
