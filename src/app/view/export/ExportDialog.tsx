/**
 * The export dialog.
 *
 * Modal, because export is a task with a beginning and an end — not a mode you
 * live in. Keeping it off the main surface means the timeline gets the pixels.
 *
 * Two decisions that come from having been burned:
 *
 *  - **No settings panel.** Three presets and the source default. A cutter
 *    that opens a codec dialog has already lost the argument it is making.
 *  - **The result plays here before it is offered as a download.** "It
 *    downloaded but won't play" is the worst class of bug, because it looks
 *    like success until someone tries to watch it. We found exactly that with
 *    opus-in-mp4 (docs/decisions/0008-negotiate-never-hardcode-a-codec.md), and the only reason we caught it was this check.
 */

import { createEffect, createSignal, For, onCleanup, Show } from 'solid-js'
import { Exporter, ExportCancelled, settingsFor, type ExportResult } from '../../../output/exporter.js'
import { buildExportAudio, verifyAudioTrack, type ExportAudioTrack } from '../../../audio/export-audio.js'
import { projectDuration } from '../../../model/project.js'
import { readMediaFacts, selfCheck, selfCheckLine } from '../../../output/self-check.js'
import { availablePlans, even, qualityBitrate, type ExportQuality, type PlanCandidate, type SourceFacts } from '../../../output/codecs.js'
import { log } from '../../../dev/debug.js'
import { X } from 'lucide-solid'
import type { AppState } from '../../store/state.js'
import { Modal } from '../ui/Modal.js'

const PRESETS = [
  { label: 'Match source', value: 'source' as const },
  { label: '1080p', value: 1920 },
  { label: '720p', value: 1280 },
  { label: '4K', value: 3840 },
]

export function ExportDialog(props: { state: AppState; onClose: () => void }) {
  const state = props.state
  const [preset, setPreset] = createSignal<number | 'source'>('source')
  // Quality defaults to `high`: re-encoding is generation loss, so the safe
  // default is to spend enough to keep the second generation clean. Size is a
  // deliberate choice, not a default.
  const [quality, setQuality] = createSignal<ExportQuality>('high')
  const [busy, setBusy] = createSignal(false)
  const [progress, setProgress] = createSignal({ stage: 'preparing', progress: 0, eta: 0, fps: 0, message: '' })
  const [result, setResult] = createSignal<ExportResult | null>(null)
  const [audioTrack, setAudioTrack] = createSignal<ExportAudioTrack | null>(null)
  const [meta, setMeta] = createSignal('')
  const [error, setError] = createSignal<string | null>(null)
  const [url, setUrl] = createSignal<string>('')
  /**
   * What this browser can actually produce, and why the rest is out.
   *
   * The list is measured rather than hardcoded, so the dialog never offers a
   * format the exporter will then refuse. `formatId` is null until the probe
   * lands, and the export button stays disabled until then — picking from a
   * list that is about to change underneath is worse than waiting a moment.
   */
  const [plans, setPlans] = createSignal<PlanCandidate[]>([])
  const [rejections, setRejections] = createSignal<string[]>([])
  const [probed, setProbed] = createSignal(false)
  const [formatId, setFormatId] = createSignal<string | null>(null)

  const widthFor = (): number => {
    const base = settingsFor(sourceSize())
    return preset() === 'source' ? base.width : (preset() as number)
  }

  // Re-probe whenever the resolution changes: encoder support is per-config, so
  // what is available at 1080p is not guaranteed at 4K.
  createEffect(() => {
    const width = widthFor()
    const height = Math.round((width * 9) / 16)
    const size = sourceSize()
    const fps = size?.frameRate && size.frameRate > 0 ? size.frameRate : 30
    let cancelled = false

    setProbed(false)
    void availablePlans({
      needsAudio: state.audioClipCount() > 0,
      width,
      height: even(height),
      fps,
      bitrate: qualityBitrate(size, quality(), width, even(height), fps),
    }).then(({ plans: found, notes }) => {
      if (cancelled) return
      setPlans(found)
      setRejections(notes)
      // Keep the user's choice if it survived the probe; otherwise take the best.
      setFormatId((current) => (current && found.some((p) => p.id === current) ? current : (found[0]?.id ?? null)))
      setProbed(true)
    })

    return () => {
      cancelled = true
    }
  })

  const chosenPlan = (): PlanCandidate | null => plans().find((p) => p.id === formatId()) ?? null

  let exporter: Exporter | null = null
  let video!: HTMLVideoElement
  let lastUrl: string | null = null

  function close(): void {
    exporter?.cancel()
    if (lastUrl) URL.revokeObjectURL(lastUrl)
    props.onClose()
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape' && !busy()) close()
  }
  window.addEventListener('keydown', onKey)
  onCleanup(() => window.removeEventListener('keydown', onKey))

  function sourceSize(): SourceFacts | null {
    const first = state.videoTracks().flat()[0]
    if (!first) return null
    const asset = state.getAsset(first.assetId)
    if (!asset) return null
    return {
      width: asset.width,
      height: asset.height,
      frameRate: asset.frameRate,
      variableFrameRate: asset.variableFrameRate,
      // Size and duration let the export match the source's bitrate instead of
      // re-encoding at a fixed formula that can be ten times larger.
      size: asset.size,
      duration: asset.duration,
      hasAudio: asset.hasAudio,
    }
  }

  async function start(): Promise<void> {
    setBusy(true)
    setError(null)
    setResult(null)
    setMeta('')
    setAudioTrack(null)
    if (lastUrl) URL.revokeObjectURL(lastUrl)

    const base = settingsFor(sourceSize(), quality())
    const width = preset() === 'source' ? base.width : (preset() as number)
    const height = preset() === 'source' ? base.height : Math.round((width * 9) / 16)
    const settings = {
      ...base,
      width,
      height,
      // Recomputed for the chosen resolution and quality.
      bitrate: qualityBitrate(sourceSize(), quality(), even(width), even(height), base.fps),
    }

    exporter = new Exporter({
      library: state.library,
      onProgress: (p) => setProgress({ ...p, message: p.message ?? '' }),
    })

    try {
      // Mix first and check it against the docs/export.md#av-sync invariants, so a broken audio
      // track is reported before we spend a minute encoding video.
      const duration = projectDuration(state.project)
      const track = await buildExportAudio(state.project, duration, {
        library: state.library,
        getAssetAudio: state.getAssetAudio,
      })
      if (track) {
        const check = verifyAudioTrack(track, duration, settings.fps)
        if (check.ok) log.info('export audio check: passed')
        else for (const problem of check.problems) log.warn(`export audio check: ${problem}`)
      }
      setAudioTrack(track)

      const output = await exporter.run(
        state.project,
        settings,
        track ? { buffer: track.buffer } : null,
        formatId() ?? undefined,
      )
      setResult(output)

      lastUrl = URL.createObjectURL(output.blob)
      setUrl(lastUrl)
      video.load()
      video.src = lastUrl
    } catch (err) {
      if (err instanceof ExportCancelled) log.info('export cancelled')
      else {
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        log.error(`export failed: ${message}`)
      }
    } finally {
      setBusy(false)
      exporter = null
    }
  }

  return (
    <Modal
      placement="center"
      tone="heavy"
      z={50}
      onClose={() => {
        if (!busy()) close()
      }}
      panelClass="max-h-full w-full max-w-3xl"
    >
        {/* header */}
        <div class="flex h-11 shrink-0 items-center gap-3 border-b border-line px-4">
          <span class="text-[13px] font-semibold">Export</span>
          <span class="timecode text-mini text-muted">
            {formatTime(state.duration())} · {state.videoClipCount()} video · {state.audioClipCount()} audio
          </span>
          <span class="flex-1" />
          <button class="icon-btn" onClick={close} disabled={busy()} title="Close (Esc)" aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto p-4">
          {/* setup */}
          <Show when={!result() && !busy()}>
            <div class="flex flex-wrap items-end gap-4">
              <label class="flex flex-col gap-1.5">
                <span class="panel-label">Resolution</span>
                <select
                  class="rounded-md border border-line bg-raised px-2.5 py-1.5 text-small outline-none
                         focus:border-accent"
                  value={String(preset())}
                  onChange={(e) => setPreset(e.currentTarget.value === 'source' ? 'source' : Number(e.currentTarget.value))}
                >
                  {PRESETS.map((p) => (
                    <option value={String(p.value)}>{p.label}</option>
                  ))}
                </select>
              </label>

              <label class="flex flex-col gap-1.5">
                <span class="panel-label">Quality</span>
                <select
                  class="rounded-md border border-line bg-raised px-2.5 py-1.5 text-small outline-none focus:border-accent"
                  value={quality()}
                  onChange={(e) => setQuality(e.currentTarget.value as ExportQuality)}
                >
                  <option value="high">High</option>
                  <option value="balanced">Balanced</option>
                  <option value="source">Match source (smallest)</option>
                </select>
              </label>

              <div class="flex flex-col gap-1.5">
                <span class="panel-label">Output</span>
                <span class="timecode text-small text-muted">
                  {describeSettings(sourceSize(), preset(), quality())}
                </span>
              </div>

              <span class="flex-1" />

              <button
                class="btn btn-primary !px-4 !py-1.5"
                onClick={() => void start()}
                disabled={!probed() || !formatId()}
              >
                Start export
              </button>
            </div>

            {/* Format.
                Shown because the browser's choice is not the user's, and the
                two are not the same thing: on Linux there is no AAC encoder, so
                an unattended export lands on WebM — correct, but not what
                Instagram will take. Every row is a combination this browser
                has confirmed it can encode, so nothing here can fail on click. */}
            <div class="mt-4 flex flex-col gap-1.5">
              <span class="panel-label">Format</span>
              <Show
                when={plans().length > 0}
                fallback={<p class="text-mini text-warn">Checking what this browser can encode…</p>}
              >
                <div class="flex flex-col gap-1">
                  <For each={plans()}>
                    {(plan) => (
                      <label
                        class="flex cursor-pointer items-start gap-2.5 rounded-md border px-2.5 py-1.5 transition-colors"
                        classList={{
                          'border-accent/50 bg-accent/10': formatId() === plan.id,
                          'border-line hover:bg-raised': formatId() !== plan.id,
                        }}
                      >
                        <input
                          type="radio"
                          name="export-format"
                          class="mt-0.5 accent-[#5b8cff]"
                          checked={formatId() === plan.id}
                          onChange={() => setFormatId(plan.id)}
                        />
                        <span class="flex min-w-0 flex-col">
                          <span class="flex items-center gap-2 text-small">
                            {plan.label}
                            <Show when={plan.compatibility === 'partial'}>
                              <span class="rounded bg-[#3a3320] px-1 text-micro font-semibold uppercase text-warn">
                                not all platforms
                              </span>
                            </Show>
                            <Show when={plan.compatibility === 'silent'}>
                              <span class="rounded bg-[#2f2a3a] px-1 text-micro font-semibold uppercase text-muted">
                                no sound
                              </span>
                            </Show>
                          </span>
                          <span class="truncate text-tiny text-muted">{plan.blurb}</span>
                        </span>
                      </label>
                    )}
                  </For>
                </div>
              </Show>

              {/* Say why the other options are gone. A format list that silently
                  omits MP4 reads as "this app cannot do MP4", which is a
                  different and much more annoying claim. */}
              <Show when={rejections().length > 0}>
                <details class="mt-1 text-tiny text-muted">
                  <summary class="cursor-pointer select-none hover:text-fg">
                    Why not the other formats?
                  </summary>
                  <ul class="mt-1 flex flex-col gap-0.5 pl-4">
                    <For each={rejections()}>{(note) => <li>· {note}</li>}</For>
                  </ul>
                </details>
              </Show>

              <Show when={chosenPlan()}>
                {(plan) => (
                  <p class="mt-1 text-tiny text-muted">
                    Will be saved as <span class="timecode text-fg">export.{plan().extension}</span>
                    {plan().audio ? '' : ' (no audio track)'}
                  </p>
                )}
              </Show>
            </div>

            <p class="mt-4 text-mini leading-relaxed text-muted">
              The output matches your source by default — a cutter's input is your own footage, so the right result is
              the same footage trimmed. Format and codec are negotiated against what this browser can actually encode,
              and the file is played back here before it is offered as a download.
            </p>
          </Show>

          {/* progress */}
          <Show when={busy()}>
            <div class="py-2">
              <div class="mb-2 flex items-baseline gap-2">
                <span class="text-small font-medium capitalize">{progress().stage}</span>
                <Show when={progress().message}>
                  <span class="text-mini text-muted">{progress().message}</span>
                </Show>
                <span class="flex-1" />
                <span class="timecode text-mini text-muted">
                  {progress().fps > 0 && `${progress().fps.toFixed(0)} fps · `}
                  {progress().eta > 0 && `${progress().eta.toFixed(0)}s left`}
                </span>
              </div>
              <div class="h-1 overflow-hidden rounded-full bg-black/40">
                <div
                  class="h-full rounded-full bg-accent transition-[width] duration-200"
                  style={{ width: `${Math.max(2, Math.round(progress().progress * 100))}%` }}
                />
              </div>
              <div class="mt-3">
                <button class="btn" onClick={() => exporter?.cancel()}>
                  Cancel
                </button>
              </div>
            </div>
          </Show>

          <Show when={error()}>
            <p class="rounded-md border border-l-2 border-line border-l-danger bg-raised px-3 py-2 text-small text-danger">
              {error()}
            </p>
          </Show>

          {/* result */}
          <Show when={result()}>
            {(output) => (
              <div class="grid gap-4 sm:grid-cols-[minmax(0,1fr)_200px]">
                <div>
                  <video
                    ref={video}
                    controls
                    class="w-full rounded-lg border border-line bg-black"
                    onError={() => {
                      const err = video.error
                      const text = err
                        ? `This browser cannot play the file we just made (code ${err.code}). Do not trust it.`
                        : 'Playback failed.'
                      setError(text)
                      log.error(`export self-playback failed: ${text}`)
                    }}
                    onLoadedMetadata={() => {
                      // Metadata is authoritative for size and duration, even
                      // before the browser can say anything about audio.
                      const info = readMediaFacts(video)
                      setMeta(selfCheckLine(info, output().hasAudio))
                    }}
                    onTimeUpdate={() => {
                      // Only replace the line once the browser can judge audio;
                      // otherwise a not-yet-decodable frame would overwrite real
                      // information with "not yet confirmed".
                      const line = selfCheck(video, output().hasAudio)
                      if (line) setMeta(line)
                    }}
                  />
                </div>

                <div class="flex flex-col gap-2.5">
                  <a
                    class="btn btn-primary !justify-center !py-2"
                    download={`export.${output().extension}`}
                    href={url()}
                  >
                    Download {output().extension}
                  </a>

                  <dl class="space-y-1.5 text-mini">
                    <Row label="format">
                      {output().plan.label}
                      {output().plan.id !== formatId() ? ' · not your choice' : ''}
                    </Row>
                    <Row label="size">{(output().size / 1e6).toFixed(2)} MB</Row>
                    <Row label="frames">{output().frames}</Row>
                    <Row label="encode">
                      {output().elapsed.toFixed(1)}s · {output().fps.toFixed(0)} fps
                    </Row>
                    <Show when={audioTrack()}>
                      {(track) => (
                        <Row label="mixed">
                          {track().buffer.duration.toFixed(2)}s @ {track().buffer.sampleRate} Hz
                          {track().silent && (
                            <span class="ml-1 text-warn">⚠ silent</span>
                          )}
                        </Row>
                      )}
                    </Show>
                  </dl>

                  <Show when={meta()}>
                    <p class="rounded-md border border-line bg-raised px-2 py-1.5 text-mini text-muted">{meta()}</p>
                  </Show>

                  <button class="btn mt-auto" onClick={() => void start()}>
                    Export again
                  </button>
                </div>
              </div>
            )}
          </Show>
        </div>
    </Modal>
  )
}

function Row(props: { label: string; children: import('solid-js').JSX.Element }) {
  return (
    <div class="flex items-baseline gap-2">
      <dt class="w-14 shrink-0 text-muted">{props.label}</dt>
      <dd class="timecode min-w-0 truncate">{props.children}</dd>
    </div>
  )
}

function describeSettings(source: SourceFacts | null, preset: number | 'source', quality: ExportQuality): string {
  const base = settingsFor(source)
  const width = preset === 'source' ? base.width : preset
  const height = preset === 'source' ? base.height : Math.round((preset * 9) / 16)
  const bitrate = qualityBitrate(source, quality, width, height, base.fps)
  return `${width}×${height} @ ${base.fps}fps · ${(bitrate / 1e6).toFixed(1)} Mbps`
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

