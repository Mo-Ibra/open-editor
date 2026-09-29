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

import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js'

import { AssetBin } from './AssetBin.js'
import { ContextMenu, createContextMenu } from './ContextMenu.js'
import { createFullscreen } from './fullscreen.js'
import { ExportDialog } from './ExportDialog.js'
import { LogPanel } from './LogPanel.js'
import { Preview } from './Preview.js'
import { ShortcutsPanel } from './ShortcutsPanel.js'
import { formatTime } from './format.js'
import type { AppState } from '../store/state.js'
import { Resizer } from './Resizer.js'
import { Timeline } from './Timeline.js'

import { createKeyHandler } from '../commands/keyboard.js'
import { createLayout, mainRows } from '../store/layout.js'
import { menuItems } from '../commands/menu-items.js'
import { createShortcuts, suppressNativeMenu } from '../commands/shortcuts.js'
import { createAppState } from '../store/state.js'

export function App() {
  const state = createAppState()
  const layout = createLayout()
  const menu = createContextMenu()
  // Built after `state`, because a refused request needs somewhere to report.
  const fullscreen = createFullscreen((message) => state.notify('warn', message))
  const [exportOpen, setExportOpen] = createSignal(false)
  const [logOpen, setLogOpen] = createSignal(false)
  const [keysOpen, setKeysOpen] = createSignal(false)

  // One list, three consumers: the key handler, the keyboard panel, and the
  // topbar's own tooltips. Deriving all of them from it is what stops the app
  // advertising a key that does nothing.
  const shortcuts = createShortcuts({
    state,
    closeMenu: menu.hide,
    layout,
    fullscreen,
    openKeys: () => setKeysOpen(true),
  })

  // Built ONCE. Calling createKeyHandler again for the removal would hand
  // removeEventListener a different function object, silently fail to unregister
  // the first, and leave a second live copy of the handler on the window.
  const onKeyDown = createKeyHandler(shortcuts)

  // Escape closes the panels.
  //
  // On a `window` listener in the capture phase, rather than `onKeyDown` on the
  // panels themselves: opening a panel does not move focus, so a handler on the
  // panel would only fire for the user who happened to tab into it first. The
  // keyboard panel had no Escape at all for exactly that reason.
  onMount(() => {
    const onEscape = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (keysOpen()) {
        setKeysOpen(false)
        return
      }
      if (logOpen()) setLogOpen(false)
    }
    window.addEventListener('keydown', onEscape, { capture: true })
    onCleanup(() => window.removeEventListener('keydown', onEscape, { capture: true }))
  })

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
      <TopBar
        state={state}
        onExport={() => setExportOpen(true)}
        onOpenLogs={() => setLogOpen(true)}
        onOpenKeys={() => setKeysOpen(true)}
      />

      <div
        class="relative grid min-h-0 flex-1"
        style={{ 'grid-template-columns': `${layout.sidebarTrack()} minmax(0, 1fr)` }}
      >
        <div class="relative min-h-0 min-w-0 overflow-hidden">
          <AssetBin state={state} menu={menu} layout={layout} />
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
          class="relative grid min-h-0 min-w-0"
          style={{ 'grid-template-rows': mainRows(layout.pictureHidden(), layout.timelineTrack()) }}
        >
          <Preview state={state} menu={menu} layout={layout} fullscreen={fullscreen} />

          <div class="relative min-h-0 min-w-0 overflow-hidden">
            <Timeline state={state} menu={menu} layout={layout} />
          </div>

          {/* A sibling of the timeline, not a child of it.
              A collapsed timeline is 0px tall and clips its overflow, so a
              handle inside it gets clipped away — the tab was in the DOM, had a
              real box, responded to .click(), and was unclickable by a human,
              because the transport bar was what a pointer actually hit. The
              sidebar handle has always been a sibling for the same reason.
              Positioned from the bottom, which is the boundary only while the
              timeline is the bottom row — and the one case where it is not (the
              picture hidden) is exactly when this is not rendered. */}
          <Show when={!layout.pictureHidden()}>
            <Resizer
              axis="y"
              at={{ bottom: layout.timelineTrack() }}
              onDrag={(e) => layout.beginTimelineDrag(e)}
              onToggle={() => layout.toggleTimeline()}
              collapsed={layout.timelineCollapsed()}
              title="Drag to resize · double-click to collapse"
            />
          </Show>
        </main>
      </div>

      <StatusFooter state={state} pictureHidden={layout.pictureHidden} />

      <ContextMenu state={menu} items={() => menuItems(state, menu, layout, fullscreen)} />

      <Show when={exportOpen()}>
        <ExportDialog state={state} onClose={() => setExportOpen(false)} />
      </Show>

      <Show when={logOpen()}>
        <LogPanel onClose={() => setLogOpen(false)} />
      </Show>
      <Show when={keysOpen()}>
        <ShortcutsPanel shortcuts={shortcuts} onClose={() => setKeysOpen(false)} />
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
  onOpenLogs: () => void
  onOpenKeys: () => void
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
        <button
          class="btn"
          onClick={props.onOpenLogs}
          title="Show what the app has been logging — errors, decoder complaints, export steps"
        >
          logs
        </button>
        <button class="btn" onClick={props.onOpenKeys} title="Keyboard shortcuts (?)">
          keys
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

/**
 * The status bar.
 *
 * It used to be the permanent keymap, which had grown to twenty-four entries and
 * two rows of the editor's most valuable space — a table of contents nobody
 * reads. A status bar's job is *now*: where the playhead is, what is selected,
 * which modes are on. The keymap is one click away in the topbar instead, where
 * it is reference rather than furniture.
 */
function StatusFooter(props: { state: AppState; pictureHidden: () => boolean }) {
  const state = props.state
  return (
    <footer class="flex h-7 shrink-0 items-center gap-3 border-t border-line bg-panel px-3 text-[10.5px] text-muted">
      <span class="timecode text-fg">{formatTime(state.playhead())}</span>
      <span class="timecode">/ {formatTime(state.duration())}</span>

      <span class="text-line">|</span>
      <span>
        {state.project.video.length} video · {state.project.audio.length} audio
      </span>

      <Show when={state.selectionCount() > 0}>
        <span class="text-accent">{state.selectionCount()} selected</span>
      </Show>

      <span class="flex-1" />

      <Show when={state.snapping()}>
        <span title="Clip edges and the playhead snap (G)">snap on</span>
      </Show>
      <Show when={state.audio.isMuted}>
        <span class="text-warn" title="Everything is muted (M)">muted</span>
      </Show>
      <Show when={props.pictureHidden()}>
        <span class="text-muted">picture hidden (H)</span>
      </Show>
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
