/**
 * The log panel.
 *
 * The logs used to be reachable only as "copy the last 400 lines to the
 * clipboard", which answers a question nobody asks. The question is *what just
 * happened*, and the answer belongs on screen. Copying is still there for
 * pasting into a bug report, but it is the second action, not the only one.
 *
 * It reads `logRevision()` rather than the buffer, so a closed panel costs
 * nothing: logging must not make the app re-render on its own.
 *
 * Deliberately a plain list, not a console. The terminal still gets everything
 * through `/__debug`; this is for the lines that explain what the app *thinks*
 * is happening, which is a different question from what it printed.
 */

import { createMemo, createSignal, For, Show } from 'solid-js'
import { clear, history, logRevision, type Level } from '../../dev/debug.js'
import { Modal, PanelHeader } from './ui/Modal.js'

const LEVELS: Level[] = ['debug', 'info', 'warn', 'error']

/** Levels at or above this are shown. Errors and warnings are never hidden. */
const RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export function LogPanel(props: { onClose: () => void }) {
  const [min, setMin] = createSignal<Level>('info')
  const [copied, setCopied] = createSignal(false)

  const entries = createMemo(() => {
    logRevision()
    const floor = RANK[min()]
    return history().filter((e) => RANK[e.level] >= floor)
  })

  // Warnings and errors stay visible at every threshold: a filter that can hide
  // the one line explaining the fault is worse than no filter.
  const problems = createMemo(() => history().filter((e) => RANK[e.level] >= RANK.warn).length)

  async function copyAll(): Promise<void> {
    try {
      await navigator.clipboard.writeText(entries().map((e) => e.message).join('\n'))
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  return (
    <Modal
      placement="right"
      variant="drawer"
      onClose={props.onClose}
      panelClass="h-full w-[min(560px,90vw)]"
      panelAttrs={{ 'data-log-panel': 'true' }}
    >
      <PanelHeader title="Logs" onClose={props.onClose}>
        <Show when={problems() > 0}>
          <span
            class="rounded-full bg-warn/20 px-1.5 text-[10px] font-semibold text-warn"
            title={`${problems()} warnings or errors this session`}
          >
            {problems()}
          </span>
        </Show>
        <span class="text-[10.5px] text-muted">{entries().length} shown</span>
        <button class="btn btn-ghost !px-2" onClick={() => void copyAll()}>
          {copied() ? 'copied' : 'copy'}
        </button>
        <button class="btn btn-ghost !px-2" onClick={() => clear()} title="Empty the log buffer">
          clear
        </button>
      </PanelHeader>

        <div class="flex shrink-0 items-center gap-1 border-b border-line-soft px-3 py-1.5">
          <span class="text-[10.5px] text-muted">show</span>
          <For each={LEVELS}>
            {(level) => (
              <button
                class="btn btn-ghost !px-2 !py-0.5 !text-[10.5px] capitalize"
                classList={{ '!border-accent/50 !text-accent': min() === level }}
                onClick={() => setMin(level)}
                aria-pressed={min() === level}
              >
                {level}
              </button>
            )}
          </For>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto font-mono text-[11px] leading-relaxed">
          <Show
            when={entries().length > 0}
            fallback={
              <p class="px-3 py-6 text-center text-muted">
                Nothing logged at this level yet.
              </p>
            }
          >
            <For each={entries()}>
              {(entry) => (
                <div
                  class="flex gap-2 border-b border-line-soft/40 px-3 py-1"
                  classList={{ 'text-danger': entry.level === 'error' }}
                >
                  <span class="shrink-0 text-muted">
                    {new Date(entry.time).toISOString().slice(11, 19)}
                  </span>
                  <span class="w-9 shrink-0 uppercase text-muted">{entry.level}</span>
                  <span class="min-w-0 flex-1 break-words whitespace-pre-wrap">{entry.message}</span>
                </div>
              )}
            </For>
          </Show>
        </div>
    </Modal>
  )
}
