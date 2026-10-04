/**
 * The media bin.
 *
 * Densely packed, because a folder of clips is a list, not a gallery — a
 * thumbnail grid is prettier and slower to scan, and the metadata is what
 * people actually compare on.
 *
 * Three things make it usable once a shoot's worth of files is in it:
 *
 * - **Search and a type filter**, because scrolling is not how a file is found
 *   when its name is already known.
 * - **Hover actions** (add, remove) on the row itself. The context menu still
 *   has everything, but the two actions people repeat are one click.
 * - **Keyboard reachability.** The row is a real button: Enter adds, Space
 *   selects, Delete removes. A drag target is an affordance, not the only one.
 */

import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import { Plus, Search, Trash2 } from 'lucide-solid'
import type { Asset } from '../../../model/project.js'
import type { AppState } from '../../store/state.js'
import type { ContextMenuState } from '../ui/ContextMenu.js'
import type { LayoutState } from '../../store/layout.js'
import { PanelToggle } from '../shell/PanelToggle.js'
import { thumbnailFor } from './thumbnail.js'

export function AssetBin(props: { state: AppState; menu: ContextMenuState; layout: LayoutState }) {
  const state = props.state
  let input!: HTMLInputElement
  const [query, setQuery] = createSignal('')
  const [kind, setKind] = createSignal<'all' | 'video' | 'audio'>('all')

  const allIds = () => state.assetIds()

  /** The ids that pass the text and type filters, in bin order. */
  const ids = createMemo(() => {
    const q = query().trim().toLowerCase()
    const filter = kind()
    return allIds().filter((id) => {
      const asset = state.getAsset(id)
      if (!asset) return false
      if (filter === 'video' && !asset.hasVideo) return false
      if (filter === 'audio' && !asset.hasAudio) return false
      if (q && !asset.name.toLowerCase().includes(q)) return false
      return true
    })
  })

  const hasFiles = (): boolean => allIds().length > 0

  function choose(): void {
    input.click()
  }

  function useFiles(files: File[]): void {
    if (files.length) void state.addFiles(files)
  }

  return (
    <aside
      class="flex min-h-0 min-w-0 flex-1 flex-col border-r border-line bg-panel"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        // Stop here: the app shell also listens for drops and imports files, so
        // without this a file dropped on the bin is imported twice.
        e.stopPropagation()
        useFiles([...(e.dataTransfer?.files ?? [])])
      }}
    >
      <div class="flex h-9 shrink-0 items-center gap-2 border-b border-line-soft px-3">
        <span class="panel-label">Media</span>
        <Show when={hasFiles()}>
          <span class="chip">{ids().length === allIds().length ? allIds().length : `${ids().length}/${allIds().length}`}</span>
        </Show>
        <span class="flex-1" />
        <button class="icon-btn" onClick={choose} disabled={state.loading()} title="Add files" aria-label="Add files">
          <Plus size={15} />
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

      <Show when={hasFiles()}>
        <div class="flex shrink-0 items-center gap-1.5 border-b border-line-soft px-2 py-1.5">
          <label class="relative flex min-w-0 flex-1 items-center">
            <Search size={13} class="pointer-events-none absolute left-2 text-faint" />
            <input
              type="search"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              placeholder="Filter…"
              class="w-full rounded-md border border-line bg-raised py-1 pl-7 pr-2 text-mini text-fg outline-none placeholder:text-faint focus:border-accent/60"
            />
          </label>
          <div class="flex shrink-0 items-center rounded-md border border-line bg-raised p-0.5">
            <For each={['all', 'video', 'audio'] as const}>
              {(k) => (
                <button
                  class="rounded px-1.5 py-0.5 text-tiny font-medium capitalize transition-colors"
                  classList={{
                    'bg-accent/20 text-accent': kind() === k,
                    'text-muted hover:text-fg': kind() !== k,
                  }}
                  onClick={() => setKind(k)}
                  aria-pressed={kind() === k}
                >
                  {k}
                </button>
              )}
            </For>
          </div>
        </div>
      </Show>

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
              <span class="text-small">Drop files here</span>
              <span class="text-tiny opacity-70">or click to browse</span>
            </button>
          }
        >
          <Show when={ids().length > 0} fallback={<p class="px-2 py-6 text-center text-mini text-muted">No files match.</p>}>
            <ul class="flex flex-col gap-px">
              <For each={ids()}>
                {(id) => {
                  const entry = () => state.entryFor(id)
                  const asset = () => state.getAsset(id)
                  return (
                    <Show when={entry() && asset()}>
                      <li class="group relative">
                        <div
                          role="button"
                          tabindex="0"
                          class="flex w-full cursor-grab items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors hover:border-line hover:bg-raised active:cursor-grabbing"
                          classList={{
                            'border-accent/50 bg-accent/10': state.selectedAsset() === id,
                            'border-transparent': state.selectedAsset() !== id,
                          }}
                          title={`${asset()!.name} — drag onto the timeline, or double-click to append`}
                          draggable={true}
                          onDragStart={(ev) => {
                            // HTML5 drag rather than pointer events: it gives a
                            // native drag image and does not collide with the
                            // timeline's pointer-capture drags.
                            draggingId = id
                            ev.dataTransfer?.setData(DND_ASSET, id)
                            ev.dataTransfer?.setData('text/plain', asset()!.name)
                            // `copyMove`, not `copy`: the timeline offers 'move' for an
                            // overwrite drop, and an effect it did not allow is a drop the
                            // browser silently refuses.
                            if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'copyMove'
                          }}
                          // Fires for a completed drop *and* a cancelled drag, so
                          // the shared id never outlives the gesture.
                          onDragEnd={() => {
                            draggingId = null
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
                          onKeyDown={(ev) => {
                            if (ev.key === 'Enter') {
                              ev.preventDefault()
                              state.addAssetToTimeline(id)
                            } else if (ev.key === ' ') {
                              ev.preventDefault()
                              state.setSelectedAsset(state.selectedAsset() === id ? null : id)
                            } else if (ev.key === 'Delete' || ev.key === 'Backspace') {
                              ev.preventDefault()
                              state.removeAsset(id)
                            }
                          }}
                          onContextMenu={(ev) => {
                            ev.preventDefault()
                            state.setSelectedAsset(id)
                            props.menu.show({ kind: 'asset', assetId: id, x: ev.clientX, y: ev.clientY })
                          }}
                        >
                          <Thumbnail state={state} assetId={id} asset={asset()!} />
                          <div class="min-w-0 flex-1">
                            <div class="truncate text-small text-fg">{asset()!.name}</div>
                            <div class="truncate text-tiny text-muted">{describe(asset()!)}</div>
                          </div>
                        </div>
                        {/* Hidden until hover, so a dense list stays readable. */}
                        <div class="absolute right-1.5 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 group-hover:flex group-focus-within:flex">
                          <button
                            class="icon-btn !size-6 bg-raised/80 backdrop-blur"
                            title="Add to the timeline"
                            aria-label="Add to the timeline"
                            onClick={(ev) => {
                              ev.stopPropagation()
                              state.addAssetToTimeline(id)
                            }}
                          >
                            <Plus size={13} />
                          </button>
                          <button
                            class="icon-btn !size-6 bg-raised/80 text-muted backdrop-blur hover:text-danger"
                            title="Remove from the project. The file on disk is untouched."
                            aria-label="Remove from the project"
                            onClick={(ev) => {
                              ev.stopPropagation()
                              state.removeAsset(id)
                            }}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </li>
                    </Show>
                  )
                }}
              </For>
            </ul>
          </Show>

          <p class="px-2 py-2 text-tiny leading-relaxed text-muted">
            Drag a file onto a lane, or double-click to append it.
          </p>
        </Show>
      </div>
    </aside>
  )
}

/** Shared with the timeline's drop handling. */
export const DND_ASSET = 'application/x-open-editor-asset'

/**
 * The asset currently being dragged from the bin, if any.
 *
 * The drag's `dataTransfer` is in protected mode during `dragover`, where the
 * spec says `getData` returns an empty string — Firefox enforces this, and the
 * timeline's drop cue would silently stop appearing. The data store is readable
 * on `drop`, but the preview needs it earlier, so the id is kept here as well.
 */
let draggingId: string | null = null
export function draggedAssetId(): string | null {
  return draggingId
}

/**
 * A frame from the file, or a coloured type tile while it decodes or if it has
 * no picture.
 *
 * One frame off the front, drawn fit into a 16:9 tile. It is the cheapest way
 * to tell six clips of the same shoot apart, and the decode is the same one the
 * preview does — the sink already exists.
 */
function Thumbnail(props: { state: AppState; assetId: string; asset: Asset }) {
  const [thumb, setThumb] = createSignal<string | null>(null)

  createEffect(() => {
    if (!props.asset.hasVideo) return
    void thumbnailFor(props.state, props.assetId).then(setThumb)
  })

  return (
    <span
      class="relative grid h-7 w-12 shrink-0 place-items-center overflow-hidden rounded-[5px]"
      classList={{
        'bg-[#1e3a63] text-[#8fb6ff]': props.asset.hasVideo,
        'bg-[#14402f] text-[#6fd39a]': !props.asset.hasVideo,
      }}
    >
      <Show when={thumb()}>
        {(url) => <img src={url()} alt="" class="absolute inset-0 size-full object-cover" />}
      </Show>
      <Show when={!props.asset.hasVideo}>
        <span class="text-tiny font-bold">A</span>
      </Show>
      <Show when={props.asset.hasVideo && !thumb()}>
        <span class="text-tiny font-bold">V</span>
      </Show>
    </span>
  )
}

/** One line saying what a source file is, for the bin row. */
function describe(asset: Asset): string {
  const duration = formatDuration(asset.duration)
  if (!asset.hasVideo) return `audio · ${duration}`
  const fps = asset.variableFrameRate
    ? `vfr ~${asset.frameRate.toFixed(1)}`
    : `${asset.frameRate.toFixed(0)}fps`
  return `${asset.width}×${asset.height} · ${fps} · ${duration}`
}

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
