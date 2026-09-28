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
import { createAppState, type AppState } from './state.js'
import { dump, log } from './debug.js'
import { createLayout } from './layout.js'
import {
  ContextMenu,
  createContextMenu,
  shouldSuppressNativeMenu,
  type MenuItem,
} from './ui/ContextMenu.js'
import { Resizer } from './ui/Resizer.js'

const SHORTCUTS: [string, string][] = [
  ['space', 'play'],
  ['S', 'split'],
  ['⌘D', 'duplicate'],
  ['⌫', 'delete'],
  ['←→', 'step'],
  ['^click', 'add to selection'],
  ['⇧click', 'extend selection'],
  ['⌘A', 'select all'],
  ['esc', 'deselect'],
  ['M', 'mute selection'],
  ['G', 'snap'],
  ['⌘Z', 'undo'],
]

export function App() {
  const state = createAppState()
  const [exportOpen, setExportOpen] = createSignal(false)
  const layout = createLayout()
  const menu = createContextMenu()

  function onKeyDown(event: KeyboardEvent): void {
    const target = event.target as HTMLElement
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return
    // A focused button owns space and enter; handling them here too would make
    // one keypress both activate the button and do whatever it means globally.
    if (target.tagName === 'BUTTON' && (event.key === ' ' || event.key === 'Enter')) return

    const accel = event.ctrlKey || event.metaKey

    switch (event.key) {
      case ' ':
        event.preventDefault()
        void state.togglePlay()
        break
      case 'd':
      case 'D':
        // Duplicate, the one command worth a modifier: it is the only edit here
        // that is both frequent and irreversible-feeling without undo.
        if (!accel) break
        event.preventDefault()
        state.duplicateSelected()
        break
      case 'a':
      case 'A':
        if (!accel) break
        event.preventDefault()
        state.selectAll()
        break
      case 'Escape':
        state.clearSelection()
        menu.hide()
        break
      case 's':
      case 'S':
        if (state.project.video.length || state.project.audio.length) {
          // With several clips selected, S splits all of them; with one (or
          // none) it keeps the old behaviour of splitting under the playhead.
          if (state.selectionCount() > 1) state.splitSelectionAtPlayhead()
          else state.splitAt(state.playhead())
        }
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
        // M mutes the selection when there is one, and the master otherwise —
        // otherwise you could never mute the whole project mid-edit.
        if (state.selectedLanes().includes('audio')) state.toggleMuteSelected()
        else state.audio.setMuted(!state.audio.isMuted)
        break
      case 'g':
      case 'G':
        state.setSnapping(!state.snapping())
        state.notify('info', `Snapping ${state.snapping() ? 'on' : 'off'}`)
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

  onMount(() => {
    window.addEventListener('keydown', onKeyDown)
    // The native menu is suppressed on app chrome only — see
    // `shouldSuppressNativeMenu` for why text fields are excluded.
    window.addEventListener(
      'contextmenu',
      (e) => {
        if (shouldSuppressNativeMenu(e)) e.preventDefault()
      },
      { capture: true },
    )
  })
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
      <div
        class="relative grid min-h-0 flex-1"
        style={{ 'grid-template-columns': `${layout.sidebarTrack()} minmax(0, 1fr)` }}
      >
        <div class="relative min-h-0 min-w-0 overflow-hidden">
          <AssetBin state={state} menu={menu} />
        </div>

        {/* Drag or double-click to resize; double-click collapses. */}
        <Resizer
          axis="x"
          // The boundary between the sidebar track and the rest.
          at={{ left: layout.sidebarTrack() }}
          onDrag={(e) => layout.beginSidebarDrag(e)}
          onToggle={() => layout.toggleSidebar()}
          collapsed={layout.sidebarCollapsed()}
          title="Drag to resize · double-click to collapse"
        />

        <main class="grid min-h-0 min-w-0" style={{ 'grid-template-rows': `minmax(0, 1fr) ${layout.timelineTrack()}` }}>
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

      <ContextMenu state={menu} items={() => menuItems(state, menu, layout)} />

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

/**
 * The menu, built from what was right-clicked.
 *
 * Every row does something real. A context menu of disabled placeholders is
 * worse than no context menu: it teaches people that the feature does not
 * exist.
 */
function menuItems(
  state: AppState,
  menu: ReturnType<typeof createContextMenu>,
  layout: ReturnType<typeof createLayout>,
): MenuItem[] {
  const target = menu.open()

  if (target?.kind === 'clip') {
    // The timeline's right-click already made the selection match the target,
    // so these act on the whole selection — one clip, or a ctrl-clicked group.
    const n = state.selectionCount()
    const many = n > 1
    const clips = state.selectedClips()
    const linked = state.selectionHasLinks()
    const hasAudio = clips.some((c) => c.lane === 'audio')
    const allMuted = clips.filter((c) => c.lane === 'audio').every((c) => c.muted)
    const count = (one: string, manyLabel: string) => (many ? manyLabel.replace('%d', String(n)) : one)

    return [
      // Disabled rather than hidden when nothing is selected, so the menu does
      // not change shape as the pointer moves between clips.
      { label: count('Split at playhead', 'Split %d clips at playhead'), shortcut: 'S', disabled: n === 0, run: () => state.splitSelectionAtPlayhead() },
      { label: count('Duplicate', 'Duplicate %d clips'), shortcut: '⌘D', disabled: n === 0, run: () => state.duplicateSelected() },
      { separator: true, label: '', run: () => undefined },
      { label: count('Trim to playhead', 'Trim %d clips to playhead'), disabled: n === 0, run: () => state.trimSelectionToPlayhead() },
      {
        label: linked ? count('Break link', 'Break %d links') : 'unlinked',
        disabled: !linked,
        run: () => state.breakSelectedLinks(),
      },
      // Omitted entirely, not disabled: a "Mute" row on a video clip is a
      // promise the app cannot keep, and a greyed-out row still reads as
      // "this is a thing that exists here".
      ...(hasAudio
        ? [
            {
              label: allMuted ? count('Unmute', 'Unmute %d clips') : count('Mute', 'Mute %d clips'),
              shortcut: 'M',
              disabled: false,
              run: () => state.toggleMuteSelected(),
            },
          ]
        : []),
      { separator: true, label: '', run: () => undefined },
      { label: count('Delete clip', 'Delete %d clips'), shortcut: '⌫', danger: true, disabled: n === 0, run: () => state.deleteSelected() },
    ]
  }

  if (target?.kind === 'lane') {
    const lane = target.lane ?? 'video'
    const selectedFile = state.selectedAsset()
    const file = selectedFile ? state.project.assets[selectedFile] : undefined
    return [
      {
        label: file ? `Add "${file.name}" here` : 'Add the selected file here',
        disabled: !file,
        // Disabled rather than hidden when nothing is selected, so the menu
        // does not change shape as the user moves between lanes.
        run: () => selectedFile && state.addAssetAt(selectedFile, lane, state.playhead()),
      },
      { separator: true, label: '', run: () => undefined },
      {
        label: `Clear ${lane} lane`,
        danger: true,
        disabled: state.laneOf(state.project, lane).length === 0,
        run: () => state.clearLane(lane),
      },
    ]
  }

  if (target?.kind === 'asset') {
    return [
      { label: 'Add to timeline', run: () => target.assetId && state.addAssetToTimeline(target.assetId) },
      { label: 'Select', run: () => target.assetId && state.setSelectedAsset(target.assetId) },
      { separator: true, label: '', run: () => undefined },
      {
        label: 'Remove from project',
        danger: true,
        run: () => target.assetId && state.removeAsset(target.assetId),
      },
    ]
  }

  if (target?.kind === 'preview') {
    return [
      { label: 'Fit to window', run: () => state.resetView() },
      { label: 'Reset zoom', run: () => state.setTransformActive({ scale: 1, x: 0, y: 0 }) },
      { separator: true, label: '', run: () => undefined },
      { label: 'Copy logs', run: () => void navigator.clipboard?.writeText(dump()) },
    ]
  }

  return [
    { label: 'Undo', shortcut: '⌘Z', disabled: !state.canUndo(), run: state.undo },
    { label: 'Redo', shortcut: '⇧⌘Z', disabled: !state.canRedo(), run: state.redo },
    { separator: true, label: '', run: () => undefined },
    { label: state.snapping() ? 'Snapping: on' : 'Snapping: off', shortcut: 'G', run: () => state.setSnapping(!state.snapping()) },
    { label: state.audio.isMuted ? 'Unmute' : 'Mute', shortcut: 'M', run: () => state.audio.setMuted(!state.audio.isMuted) },
    { separator: true, label: '', run: () => undefined },
    { label: 'Reset panels', run: () => layout.reset() },
    { label: 'Copy logs', run: () => void navigator.clipboard?.writeText(dump()) },
  ]
}
