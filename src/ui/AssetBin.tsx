/**
 * Asset bin: the dropped files, with real probed metadata.
 */

import { For, Show } from 'solid-js'
import type { AppState } from '../state.js'

export function AssetBin(props: { state: AppState }) {
  const state = props.state
  let input!: HTMLInputElement

  const ids = () => state.assetIds()

  return (
    <aside class="bin" onDragOver={(e) => e.preventDefault()} onDrop={(e) => {
      e.preventDefault()
      const files = [...(e.dataTransfer?.files ?? [])]
      if (files.length) void state.addFiles(files)
    }}>
      <header>
        <h2>Media</h2>
        <button class="ghost" onClick={() => input.click()}>Add…</button>
        <input
          ref={input}
          type="file"
          accept="video/*"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.currentTarget.files ?? [])]
            if (files.length) void state.addFiles(files)
            e.currentTarget.value = ''
          }}
        />
      </header>

      <Show when={ids().length === 0}>
        <p class="hint pad">Drop video files here.</p>
      </Show>

      <Show when={state.loading()}>
        <p class="hint pad">Reading…</p>
      </Show>

      <ul class="assets">
        <For each={ids()}>
          {(id) => {
            const entry = state.entryFor(id)
            if (!entry) return null
            return (
            <li>
              <button
                class="asset"
                disabled={!!entry.error}
                title={entry.error ?? `${entry.asset.width}×${entry.asset.height}`}
                onDblClick={() => state.addClip(entry.asset.id)}
                onClick={(e) => {
                  state.addClip(entry.asset.id)
                  // Hand focus back to the document, so space is a transport
                  // key again instead of re-triggering this button.
                  e.currentTarget.blur()
                }}
              >
                <span class="name">{entry.asset.name}</span>
                <span class="meta">
                  {entry.asset.width}×{entry.asset.height}
                  {' · '}
                  {entry.asset.variableFrameRate
                    ? `VFR ~${entry.asset.frameRate.toFixed(1)}`
                    : `${entry.asset.frameRate.toFixed(0)}fps`}
                  {' · '}
                  {formatDuration(entry.asset.duration)}
                  {entry.asset.rotation !== 0 && ` · ${entry.asset.rotation}°`}
                </span>
                <Show when={entry.error}>
                  <span class="err">{entry.error}</span>
                </Show>
              </button>
            </li>
            )
          }}
        </For>
      </ul>

      <Show when={ids().length > 0}>
        <p class="hint pad">Click to append to the timeline.</p>
      </Show>
    </aside>
  )
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '—'
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`
}
