/**
 * The media bin.
 *
 * Densely packed, because a folder of clips is a list, not a gallery — a
 * thumbnail grid is prettier and slower to scan, and the metadata is what
 * people actually compare on.
 */

import { For, Show } from 'solid-js'
import type { AppState } from '../store/state.js'
import type { ContextMenuState } from './ContextMenu.js'
import type { LayoutState } from '../store/layout.js'
import { PanelToggle } from './PanelToggle.js'

export function AssetBin(props: { state: AppState; menu: ContextMenuState; layout: LayoutState }) {
  const state = props.state
  let input!: HTMLInputElement

  const ids = () => state.assetIds()
  const hasFiles = () => ids().length > 0

  function choose(): void {
    input.click()
  }

  function useFiles(files: File[]): void {
    if (files.length) void state.addFiles(files)
  }

  return (
    <aside
      class="flex min-h-0 flex-col border-r border-line bg-panel"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        useFiles([...(e.dataTransfer?.files ?? [])])
      }}
    >
      <div class="flex h-9 shrink-0 items-center gap-2 border-b border-line-soft px-3">
        <span class="panel-label">Media</span>
        <span class="flex-1" />
        <button class="btn btn-ghost !px-1.5 !py-0.5 text-[11px]" onClick={choose} disabled={state.loading()}>
          {state.loading() ? 'reading…' : 'add'}
        </button>
        <PanelToggle
          panel="media"
          collapsed={props.layout.sidebarCollapsed()}
          onToggle={() => props.layout.toggleSidebar()}
          dir="left"
        />
        <input
          ref={input}
          type="file"
          accept="video/*,audio/*"
          multiple
          hidden
          onChange={(e) => {
            useFiles([...(e.currentTarget.files ?? [])])
            e.currentTarget.value = ''
          }}
        />
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto p-1.5">
        <Show
          when={hasFiles()}
          fallback={
            <button
              class="flex h-full w-full flex-col items-center justify-center gap-1.5 rounded-md border border-dashed
                     border-line px-4 text-center text-muted transition-colors hover:border-[#3a3d4a] hover:text-fg"
              onClick={choose}
            >
              <DropIcon />
              <span class="text-[12px]">Drop files here</span>
              <span class="text-[10.5px] opacity-70">or click to browse</span>
            </button>
          }
        >
          <ul class="flex flex-col gap-px">
            <For each={ids()}>
              {(id) => {
                const entry = () => state.entryFor(id)
                return (
                  <Show when={entry()}>
                    {(e) => (
                      <li>
                        <button
                          class="group w-full rounded-md border px-2 py-1.5 text-left transition-colors hover:border-line hover:bg-raised"
                          classList={{
                            'border-accent/50 bg-accent/10': state.selectedAsset() === id,
                            'border-transparent': state.selectedAsset() !== id,
                          }}
                          title={`${e().asset.name} — drag onto a lane, or double-click to append`}
                          draggable={true}
                          onDragStart={(ev) => {
                            // HTML5 drag rather than pointer events: it gives a
                            // native drag image and does not collide with the
                            // timeline's pointer-capture drags.
                            ev.dataTransfer?.setData(DND_ASSET, id)
                            ev.dataTransfer?.setData('text/plain', e().asset.name)
                            if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'copy'
                          }}
                          onClick={(ev) => {
                            // A click only SELECTS. Adding to the timeline is a
                            // double-click or a drag, so a stray click cannot
                            // mutate the edit.
                            state.setSelectedAsset(state.selectedAsset() === id ? null : id)
                            ev.currentTarget.blur()
                          }}
                          onDblClick={(ev) => {
                            state.addAssetToTimeline(id)
                            ev.currentTarget.blur()
                          }}
                          onContextMenu={(ev) => {
                            ev.preventDefault()
                            state.setSelectedAsset(id)
                            props.menu.show({ kind: 'asset', assetId: id, x: ev.clientX, y: ev.clientY })
                          }}
                        >
                          <span class="flex items-center gap-1.5">
                            <span
                              class={`grid size-4 shrink-0 place-items-center rounded-[3px] text-[9px] font-bold ${
                                e().asset.hasVideo ? 'bg-[#1e3a63] text-[#8fb6ff]' : 'bg-[#14402f] text-[#6fd39a]'
                              }`}
                            >
                              {e().asset.hasVideo ? 'V' : 'A'}
                            </span>
                            <span class="truncate text-[12px]">{e().asset.name}</span>
                          </span>
                          <span class="mt-0.5 block pl-[22px] timecode text-[10px] text-muted">
                            {e().asset.hasVideo && `${e().asset.width}×${e().asset.height} · `}
                            {e().asset.variableFrameRate
                              ? `vfr ~${e().asset.frameRate.toFixed(1)}`
                              : `${e().asset.frameRate.toFixed(0)}fps`}
                            {' · '}
                            {formatDuration(e().asset.duration)}
                            {e().asset.rotation !== 0 && ` · ${e().asset.rotation}°`}
                          </span>
                          <Show when={e().error}>
                            <span class="mt-0.5 block pl-[22px] text-[10px] text-danger">{e().error}</span>
                          </Show>
                        </button>
                      </li>
                    )}
                  </Show>
                )
              }}
            </For>
          </ul>

          <p class="px-2 py-2 text-[10.5px] leading-relaxed text-muted">
            Drag a file onto a lane, or double-click to append it.
          </p>
        </Show>
      </div>
    </aside>
  )
}

/** Shared with the timeline's drop handling. */
export const DND_ASSET = 'application/x-open-editor-asset'

function DropIcon() {
  return (
    <svg viewBox="0 0 24 24" class="size-5 opacity-60" fill="none" stroke="currentColor" stroke-width="1.5">
      <path d="M12 16V4m0 0L8 8m4-4 4 4" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M4 16v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" stroke-linecap="round" />
    </svg>
  )
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—'
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`
}
