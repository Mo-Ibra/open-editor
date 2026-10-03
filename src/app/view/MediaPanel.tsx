/**
 * The media review screen: what is attached, what is not, and why.
 *
 * Shown after an import that could not find all of its media, and reachable
 * later from the project list. The edit always opens first — this screen is
 * about the files, and it is only useful *after* you can see the timeline.
 *
 * Three things it deliberately does:
 *
 * - **Shows the reason, always.** "Missing" alone sends people off to find a
 *   file they are already looking at. The difference between "not on this
 *   machine" and "here, but the content differs" is the difference between
 *   hunting and a decision.
 * - **Ranks by damage.** A missing file that nine clips depend on is above one
 *   that a single clip uses, because that is the order worth fixing in.
 * - **Never attaches on its own.** `Relink…` opens a picker and puts the
 *   decision in front of a person, who then sees why it was accepted or refused.
 *   The screen proposes; it does not conclude.
 */

import { createSignal, For, Show } from 'solid-js'
import type { AppState } from '../store/state.js'
import type { BatchItem, MediaState } from '../store/media-status.js'
import { chooseFolder, filesFromDrop, type FolderFile } from './folder.js'
import { Modal, PanelHeader } from './ui/Modal.js'

const mb = (bytes: number): string => {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

const VERDICT: Record<MediaState['status'], { label: string; tone: string }> = {
  attached: { label: 'ok', tone: 'text-ok' },
  rejected: { label: 'check', tone: 'text-warn' },
  missing: { label: 'absent', tone: 'text-danger' },
}

export function MediaPanel(props: {
  state: AppState
  onClose: () => void
  /** The browser's own file picker, as an input, so it can be tested. */
  pickFile: () => Promise<File | null>
  /** Injected so the batch path is drivable without a real directory picker. */
  pickFolder?: () => Promise<FolderFile[] | null>
}) {
  const [busy, setBusy] = createSignal<string | null>(null)
  const [verdicts, setVerdicts] = createSignal<Record<string, { ok: boolean; reason: string }>>({})
  const [progress, setProgress] = createSignal<{ done: number; total: number; label: string } | null>(null)
  const [batch, setBatch] = createSignal<{ attached: string[]; proposals: BatchItem[]; unreadable: string[]; hashed: number } | null>(null)
  /** The files behind each proposal, which `BatchItem` only names by path. */
  const [pool, setPool] = createSignal<Map<string, File>>(new Map())
  const [dropping, setDropping] = createSignal(false)

  // A signal of its own, bumped after every relink, so the list re-reads. The
  // media library is a plain Map, so it cannot be watched — a list that did not
  // refresh after attaching a file would report the file as still missing, which
  // is precisely the bug this whole screen exists to fix.
  const [revision, setRevision] = createSignal(0)
  const media = (): MediaState[] => {
    void revision()
    return props.state.projects.mediaStatus()
  }

  /**
   * Match a whole folder at once.
   *
   * Certain matches are applied inside the store; proposals come back for a
   * person to confirm, because that is the decision the user reserved. The
   * progress line is here rather than inside the walk so the store stays pure
   * enough to test and the panel owns the presentation.
   */
  const runFolder = async (files: FolderFile[] | null): Promise<void> => {
    if (!files || files.length === 0) return
    setBusy('folder')
    setBatch(null)
    setPool(new Map(files.map((f) => [f.path, f.file])))
    try {
      const result = await props.state.projects.relinkFromFolder(files, (done, total, label) =>
        setProgress({ done, total, label }),
      )
      setBatch(result)
      setRevision((n) => n + 1)
      const bits: string[] = []
      if (result.attached.length > 0) bits.push(`${result.attached.length} matched exactly`)
      if (result.proposals.length > 0) bits.push(`${result.proposals.length} need confirming`)
      if (result.unreadable.length > 0) bits.push(`${result.unreadable.length} could not be read`)
      props.state.notify(bits.length > 0 ? 'info' : 'warn', bits.join(', ') || 'Nothing in that folder matched.')
    } finally {
      setBusy(null)
      setProgress(null)
    }
  }

  const accept = async (item: BatchItem, path: string): Promise<void> => {
    const file = pool().get(path)
    if (!file) return
    setBusy(item.assetId)
    try {
      const outcome = await props.state.projects.acceptProposal(item.assetId, file)
      setVerdicts((prev) => ({ ...prev, [item.assetId]: outcome }))
      if (outcome.ok) {
        setBatch((prev) => prev && { ...prev, proposals: prev.proposals.filter((i) => i.assetId !== item.assetId) })
        setRevision((n) => n + 1)
      }
    } finally {
      setBusy(null)
    }
  }

  const attached = (): MediaState[] => media().filter((m) => m.status === 'attached')
  const unresolved = (): MediaState[] => media().filter((m) => m.status !== 'attached')

  const relink = async (m: MediaState): Promise<void> => {
    setBusy(m.assetId)
    try {
      const file = await props.pickFile()
      if (!file) return
      const outcome = await props.state.projects.relinkAsset(m.assetId, file)
      setVerdicts((prev) => ({ ...prev, [m.assetId]: outcome }))
      setRevision((n) => n + 1)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Modal
      placement="top"
      onClose={props.onClose}
      panelClass={`max-h-[82vh] w-[min(680px,94vw)] ${dropping() ? 'ring-1 ring-accent' : ''}`}
      panelAttrs={{ 'data-media-panel': 'true', 'data-dropping': dropping() ? 'true' : 'false' }}
      // A folder dropped anywhere on the panel. `dragover` has to be prevented
      // or the browser navigates to the folder and the app is simply gone — the
      // one failure here with no recovery short of reloading.
      onDragOver={(e) => {
        e.preventDefault()
        setDropping(true)
      }}
      onDragLeave={(e) => {
        if (e.target === e.currentTarget) setDropping(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        // This drop means "relink these files", not "import them into the
        // project". Stopping the bubble keeps the app shell's own drop handler
        // from adding every file in the folder as a new asset.
        e.stopPropagation()
        setDropping(false)
        void filesFromDrop(e.dataTransfer).then(runFolder)
      }}
    >
      <PanelHeader title="Media" onClose={props.onClose}>
        <span class="text-[11px] text-muted">
          {attached().length} of {media().length} attached
        </span>
        <Show when={unresolved().length > 0}>
          <button
            class="btn"
            disabled={busy() !== null}
            onClick={() => void (props.pickFolder ?? chooseFolder)().then(runFolder)}
            title="Match a whole folder against this project at once"
            data-pick-folder
          >
            Choose folder…
          </button>
        </Show>
      </PanelHeader>

        <Show when={progress()}>
          {(pr) => (
            <div class="shrink-0 border-b border-line-soft px-4 py-2" data-progress>
              <div class="h-1 overflow-hidden rounded bg-raised">
                <div
                  class="h-full bg-accent transition-[width]"
                  style={{ width: pr().total > 0 ? `${Math.round((pr().done / pr().total) * 100)}%` : '0%' }}
                />
              </div>
              <p class="mt-1 truncate text-[10.5px] text-muted">
                Checking {pr().done} of {pr().total} that could match{pr().label ? ` — ${pr().label}` : ''}
              </p>
            </div>
          )}
        </Show>

        <div class="min-h-0 flex-1 overflow-y-auto">
          <Show when={batch()?.proposals.length}>
            <div class="border-b border-line-soft bg-warn/5 px-4 py-2.5" data-proposals>
              <p class="text-[11px] text-warn">
                {batch()!.proposals.length} file{batch()!.proposals.length === 1 ? '' : 's'} look plausible but
                could not be verified. Nothing has been attached.
              </p>
              <ul class="mt-1.5">
                <For each={batch()!.proposals}>
                  {(item) => (
                    <li class="flex flex-wrap items-baseline gap-x-2 gap-y-1 py-1" data-proposal={item.assetId}>
                      <span class="truncate text-[11.5px]">{item.name}</span>
                      <span class="text-[10.5px] text-muted">
                        ← {item.proposals[0]!.file.name} ({item.proposals[0]!.match.reason})
                      </span>
                      <span class="flex-1" />
                      <button
                        class="btn !py-0.5"
                        disabled={busy() !== null}
                        onClick={() => void accept(item, item.proposals[0]!.file.assetId)}
                        data-accept={item.assetId}
                      >
                        Use this
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          </Show>

          <Show when={batch() && batch()!.attached.length > 0}>
            <p class="border-b border-line-soft px-4 py-2 text-[10.5px] text-ok" data-attached>
              {batch()!.attached.length} matched exactly and {batch()!.attached.length === 1 ? 'is' : 'are'} now
              attached.
            </p>
          </Show>

          <Show when={media().length > 0} fallback={<p class="px-4 py-8 text-center text-muted">No media in this project.</p>}>
            <ul>
              <For each={media()}>
                {(m) => {
                  const verdict = () => verdicts()[m.assetId]
                  return (
                    <li class="border-b border-line-soft px-4 py-2.5" data-media-row={m.assetId}>
                      <div class="flex items-baseline gap-2">
                        <span class="truncate text-[12.5px]">{m.name}</span>
                        <span class="flex-1" />
                        <span class={`text-[10px] uppercase tracking-wide ${VERDICT[m.status].tone}`}>
                          {VERDICT[m.status].label}
                        </span>
                      </div>
                      <div class="mt-0.5 flex items-baseline gap-2 text-[10.5px] text-muted">
                        <span>
                          {mb(m.size)}
                          {m.duration > 0 && ` · ${m.duration.toFixed(1)}s`}
                        </span>
                        <span>
                          · {m.clipCount} clip{m.clipCount === 1 ? '' : 's'}
                        </span>
                        <span>· {m.reason}</span>
                      </div>
                      <Show when={verdict()}>
                        {(v) => (
                          <p
                            class="mt-1 text-[10.5px]"
                            classList={{ 'text-ok': v().ok, 'text-danger': !v().ok }}
                            data-relink-verdict={m.assetId}
                          >
                            {v().ok
                              ? `attached — ${v().reason}`
                              : `not attached — ${v().reason}. It was left exactly as it was.`}
                          </p>
                        )}
                      </Show>
                      <Show when={m.status !== 'attached'}>
                        <button
                          class="btn mt-1.5 !py-0.5"
                          disabled={busy() === m.assetId}
                          onClick={() => void relink(m)}
                          data-relink={m.assetId}
                        >
                          Relink…
                        </button>
                      </Show>
                    </li>
                  )
                }}
              </For>
            </ul>
          </Show>
        </div>

        <Show when={unresolved().length > 0}>
          <footer class="shrink-0 border-t border-line-soft px-4 py-2.5 text-[10.5px] text-muted">
            The timeline is intact and editable. Choose a folder to check many files at
            once, or drop one here. Files are matched by content, so a re-encode or a
            renamed copy is never attached on its own — you will be told when a file is
            refused, and the old one is kept.
          </footer>
        </Show>
    </Modal>
  )
}
