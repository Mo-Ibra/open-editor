/**
 * The project list.
 *
 * Stage 2's UI over a store that already knows how to do all of this. Three
 * things it deliberately does:
 *
 * - **Says what storage costs.** A project holds a copy of its media, so the
 *   used/quota bar and the "will the browser keep this?" line are the honest
 *   part of the feature, not a footnote.
 * - **Never deletes without confirming.** Deleting a project deletes its media
 *   too, and there is no undo for that. One click, and the bytes are gone.
 * - **Names the open one.** Switching projects saves the current one first, so
 *   "open" is never a way to lose work.
 */

import { createSignal, For, Show } from 'solid-js'
import { Download, Image, Plus, Upload } from 'lucide-solid'
import type { AppState } from '../../store/state.js'
import { canPickSavePath } from './transfer.js'
import { Modal, PanelHeader } from '../ui/Modal.js'

const kb = (n: number): string => {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

const ago = (t: number): string => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.round(s / 60)} min ago`
  if (s < 86400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86400)} d ago`
}

export function ProjectPanel(props: {
  state: AppState
  onClose: () => void
  onExport: () => void
  onImport: () => void
  /** Open the review screen for the project currently open. */
  onMedia: () => void
}) {
  const projects = () => props.state.projects
  const [editing, setEditing] = createSignal<string | null>(null)
  const [draft, setDraft] = createSignal('')
  const [confirming, setConfirming] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)

  // Refresh on open: the list is stale the moment another project is saved.
  void (async () => {
    await projects().refreshList()
    await projects().refreshUsage()
  })()

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  const storage = () => projects().usage()
  const percent = (): number => {
    const { used, quota } = storage()
    return quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : 0
  }

  return (
    <Modal
      placement="top"
      onClose={props.onClose}
      panelClass="max-h-[82vh] w-[min(680px,94vw)]"
      panelAttrs={{ 'data-projects-panel': 'true' }}
    >
      <PanelHeader title="Projects" onClose={props.onClose}>
        <button class="btn" onClick={() => void run(() => projects().startNew('Untitled'))} disabled={busy()}>
          <Plus size={13} /> New
        </button>
        <button
          class="btn"
          onClick={props.onExport}
          disabled={busy()}
          title="Export the edit as a file you can open on another machine (⌘E)"
        >
          <Download size={13} /> Export
        </button>
        <button class="btn" onClick={props.onImport} disabled={busy()} title="Open a project file (⌘I)">
          <Upload size={13} /> Import
        </button>
        {/* Only for the open project: the screen describes the media of the
            edit you are looking at, so offering it while another project is
            open would describe the wrong one. */}
        <button
          class="btn"
          onClick={props.onMedia}
          disabled={busy()}
          title="Check which of this project's files are attached (⌘M)"
          data-open-media
        >
          <Image size={13} /> Media
        </button>
      </PanelHeader>

      <div class="min-h-0 flex-1 overflow-y-auto">
        <Show
          when={projects().projects().length > 0}
          fallback={<p class="px-4 py-8 text-center text-muted">No projects yet.</p>}
        >
          <ul>
            <For each={projects().projects()}>
              {(p) => (
                <li
                  class="flex items-center gap-3 border-b border-line-soft px-4 py-2.5"
                  classList={{ 'bg-accent/5': p.id === projects().id() }}
                  data-project-row={p.id}
                >
                  <div class="min-w-0 flex-1">
                    <Show
                      when={editing() === p.id}
                      fallback={
                        <p class="truncate text-small">
                          {p.name}
                          <Show when={p.id === projects().id()}>
                            <span class="ml-2 text-tiny uppercase tracking-wide text-accent">open</span>
                          </Show>
                        </p>
                      }
                    >
                      <input
                        class="w-full rounded border border-line bg-raised px-1.5 py-0.5 text-small"
                        value={draft()}
                        autofocus
                        onInput={(e) => setDraft(e.currentTarget.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            void run(async () => {
                              if (p.id === projects().id()) await projects().rename(draft())
                              setEditing(null)
                            })
                          }
                          if (e.key === 'Escape') setEditing(null)
                        }}
                      />
                    </Show>
                    <p class="text-tiny text-muted">
                      {p.clipCount} clip{p.clipCount === 1 ? '' : 's'} · {kb(p.mediaBytes)} media · saved{' '}
                      {ago(p.updated)}
                    </p>
                  </div>

                  <div class="flex shrink-0 items-center gap-1">
                    {/* Rename is always offered, including on the open
                        project. It used to be swapped for "Close" there,
                        which meant the project you were working in was the one
                        project you could not rename. */}
                    <button
                      class="btn !py-0.5"
                      disabled={busy()}
                      onClick={() => {
                        setEditing(p.id)
                        setDraft(p.name)
                      }}
                    >
                      Rename
                    </button>
                    <Show
                      when={p.id !== projects().id()}
                      fallback={
                        <button class="btn !py-0.5" disabled={busy()} onClick={() => props.onClose()}>
                          Close
                        </button>
                      }
                    >
                      <button
                        class="btn !py-0.5"
                        disabled={busy()}
                        onClick={() => void run(() => projects().open(p.id).then((ok) => ok && props.onClose()))}
                      >
                        Open
                      </button>
                    </Show>
                    <Show when={confirming() === p.id}>
                      <button
                        class="btn !border-danger !py-0.5 text-danger"
                        disabled={busy()}
                        onClick={() => void run(() => projects().remove(p.id).then(() => setConfirming(null)))}
                      >
                        Really delete
                      </button>
                    </Show>
                    <Show when={confirming() !== p.id}>
                      <button
                        class="btn btn-ghost !px-1.5 !py-0.5 text-muted hover:text-danger"
                        disabled={busy()}
                        title="Delete this project and its media. There is no undo."
                        onClick={() => setConfirming(p.id)}
                      >
                        Delete
                      </button>
                    </Show>
                  </div>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </div>

      <footer class="shrink-0 border-t border-line-soft px-4 py-2.5">
        <Show when={storage().used > 0}>
          <div class="h-1.5 overflow-hidden rounded-full bg-raised">
            <div class="h-full rounded-full bg-accent/70" style={{ width: `${percent()}%` }} />
          </div>
          <p class="mt-1.5 text-tiny text-muted">
            {kb(storage().used)}
            <Show when={storage().quota > 0}> of about {kb(storage().quota)} available</Show> — projects hold a
            copy of their media.
          </p>
        </Show>
        <p
          class="text-tiny"
          classList={{ 'text-warn': !storage().persisted, 'text-muted': storage().persisted }}
        >
          <Show
            when={storage().persisted}
            fallback="This browser may reclaim this project's storage when the disk fills up. Ask to keep it."
          >
            Storage is marked as kept.
          </Show>
        </p>
        <Show when={projects().missing().length > 0}>
          <p class="mt-1 text-tiny text-warn">
            {projects().missing().length} file(s) in the open project have no stored media — the clips are intact,
            re-import the files to see them.
          </p>
        </Show>
        <p class="mt-1 text-tiny text-muted">
          <kbd class="timecode">⌘S</kbd> saves now · <kbd class="timecode">⌘O</kbd> this list ·{' '}
          <kbd class="timecode">⌘E</kbd> export file · <kbd class="timecode">⌘I</kbd> import file.
          {canPickSavePath() ? '' : ' Files are downloaded rather than saved in place — this browser has no file picker.'}
        </p>
      </footer>
    </Modal>
  )
}
