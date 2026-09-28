/**
 * Export panel.
 *
 * Two decisions that come from having been burned:
 *
 *  - **No settings panel.** Three presets and the source default. A cutter
 *    that opens a codec dialog has already lost the argument it is making.
 *  - **The result plays in the page before it is offered as a download.**
 *    "It downloaded but won't play" is the worst class of bug, because it looks
 *    like success until someone tries to watch it. We found exactly that with
 *    opus-in-mp4 (§6.8), and the only reason we caught it was this check.
 */

import { createSignal, Show } from 'solid-js'
import { Exporter, ExportCancelled, settingsFor, type ExportResult } from '../exporter.js'
import { projectDuration } from '../project.js'
import { buildExportAudio, verifyAudioTrack, type ExportAudioTrack } from '../export-audio.js'
import { log } from '../debug.js'
import type { AppState } from '../state.js'

const PRESETS = [
  { label: 'Match source', value: 'source' as const },
  { label: '1080p', value: 1920 },
  { label: '720p', value: 1280 },
  { label: '4K', value: 3840 },
]

export function ExportPanel(props: { state: AppState }) {
  const state = props.state
  const [preset, setPreset] = createSignal<number | 'source'>('source')
  const [busy, setBusy] = createSignal(false)
  const [progress, setProgress] = createSignal({ stage: 'preparing', progress: 0, eta: 0, fps: 0, framesDone: 0, framesTotal: 0 })
  const [result, setResult] = createSignal<ExportResult | null>(null)
  const [playStatus, setPlayStatus] = createSignal<string>('')
  const [resultMeta, setResultMeta] = createSignal<string>('')
  const [error, setError] = createSignal<string | null>(null)
  const [audioTrack, setAudioTrack] = createSignal<ExportAudioTrack | null>(null)

  let exporter: Exporter | null = null
  let video!: HTMLVideoElement

  function sourceSize() {
    const first = state.project.video[0]
    if (!first) return null
    const asset = state.getAsset(first.assetId)
    if (!asset) return null
    return {
      width: asset.width,
      height: asset.height,
      frameRate: asset.frameRate,
      variableFrameRate: asset.variableFrameRate,
    }
  }

  async function start(): Promise<void> {
    setBusy(true)
    setError(null)
    setResult(null)
    setPlayStatus('')
    setResultMeta('')

    const base = settingsFor(sourceSize())
    const settings =
      preset() === 'source'
        ? base
        : { ...base, width: preset() as number, height: Math.round(((preset() as number) * 9) / 16) }

    exporter = new Exporter({
      library: state.library,
      onProgress: (p) => setProgress({ ...p }),
    })

    try {
      // Build the mix first, and check it against the §6.1 invariants before
      // spending a minute encoding video we might throw away.
      const duration = projectDuration(state.project)
      const track = await buildExportAudio(state.project, duration, {
        library: state.library,
        getAssetAudio: state.getAssetAudio,
      })

      if (track) {
        const check = verifyAudioTrack(track, duration, settings.fps)
        if (!check.ok) {
          for (const problem of check.problems) log.warn(`export audio check: ${problem}`)
          if (track.silent) {
            log.warn('export audio check: the mix is silent — exporting anyway, but check your levels')
          }
        } else {
          log.info('export audio check: passed')
        }
      }
      setAudioTrack(track)

      const output = await exporter.run(state.project, settings, track ? { buffer: track.buffer } : null)
      setResult(output)

      // Play it here first. If the browser cannot play its own output, the file
      // is broken and no download button is going to change that.
      video.load()
      video.src = URL.createObjectURL(output.blob)
      setPlayStatus('checking…')
    } catch (err) {
      if (err instanceof ExportCancelled) {
        log.info('export cancelled by the user')
      } else {
        const message = err instanceof Error ? err.message : String(err)
        setError(message)
        log.error(`export failed: ${message}`)
      }
    } finally {
      setBusy(false)
      exporter = null
    }
  }

  function onVideoError(): void {
    const err = video.error
    const text = err
      ? `The browser cannot play the file we just made (code ${err.code}). Do not trust it.`
      : 'Playback failed.'
    setPlayStatus(text)
    log.error(`export self-playback failed: ${text}`)
  }

  return (
    <div class="export">
      <div class="export-bar">
        <label>
          export
          <select value={String(preset())} onChange={(e) => setPreset(e.currentTarget.value === 'source' ? 'source' : Number(e.currentTarget.value))}>
            {PRESETS.map((p) => (
              <option value={String(p.value)}>{p.label}</option>
            ))}
          </select>
        </label>

        <button class="primary" disabled={busy() || state.project.video.length === 0} onClick={() => void start()}>
          {busy() ? 'Exporting…' : 'Export'}
        </button>

        <Show when={busy()}>
          <button onClick={() => exporter?.cancel()}>Cancel</button>
        </Show>

        <span class="spacer" />

        <Show when={busy()}>
          <span class="dim export-status">
            {progress().stage} · {Math.round(progress().progress * 100)}%
            {progress().fps > 0 && ` · ${progress().fps.toFixed(0)} fps`}
            {progress().eta > 0 && ` · ${progress().eta.toFixed(0)}s left`}
          </span>
        </Show>
      </div>

      <Show when={busy()}>
        <div class="export-progress">
          <div class="bar" style={{ width: `${Math.round(progress().progress * 100)}%` }} />
        </div>
      </Show>

      <Show when={error()}>
        <p class="export-error">{error()}</p>
      </Show>

      <Show when={result()}>
        {(output) => (
          <div class="export-result">
            <div class="row">
              <video
                ref={video}
                controls
                onError={onVideoError}
                onLoadedMetadata={() => {
                  // Chrome populates `audioTracks` only once they are enabled,
                  // and `webkitAudioDecodedByteCount` stays 0 until something
                  // has actually decoded. Reading either at this moment says
                  // "no audio" about a file that has plenty, so enable first
                  // and treat this as provisional.
                  enableAudioTracks(video)
                  const info = describe(video)
                  setResultMeta(
                    `${info.width}×${info.height}, ${info.duration.toFixed(2)}s — ` +
                      `audio ${audioVerdict(info, output().hasAudio)}`,
                  )
                }}
                onTimeUpdate={() => {
                  // Re-check once playback has had a chance to decode. Only
                  // now is `webkitAudioDecodedByteCount` meaningful.
                  const info = describe(video)
                  if (info.decodedBytes === undefined && info.mozHasAudio === undefined) return
                  const verdict = audioVerdict(info, output().hasAudio)
                  setResultMeta(
                    `${info.width}×${info.height}, ${info.duration.toFixed(2)}s — audio ${verdict}`,
                  )
                  if (verdict === 'present') log.info('export self-playback: audio confirmed by the decoder')
                }}
              />
              <div class="meta">
                <a class="primary" download={`export.${output().extension}`} href={URL.createObjectURL(output().blob)}>
                  Download {output().extension}
                </a>
                <p class="dim">
                  {output().frames} frames · {(output().size / 1e6).toFixed(2)} MB ·{' '}
                  {output().fps.toFixed(1)} fps ({output().elapsed.toFixed(1)}s)
                </p>
                <p class="dim">
                  {output().plan.extension}/{output().plan.video}
                  {output().hasAudio ? ` + ${output().audioCodec}` : ' · NO AUDIO'}
                </p>
                <Show when={audioTrack()}>
                  {(track) => (
                    <p class="dim">
                      mixed {track().buffer.duration.toFixed(2)}s @ {track().buffer.sampleRate} Hz
                      {track().silent ? ' · ⚠ silent' : ''}
                    </p>
                  )}
                </Show>
                <Show when={resultMeta()}>
                  <p class="dim">{resultMeta()}</p>
                </Show>
                <Show when={playStatus()}>
                  <p class="export-error">{playStatus()}</p>
                </Show>
              </div>
            </div>
          </div>
        )}
      </Show>
    </div>
  )
}

/**
 * What the element knows about the file's audio.
 *
 * There is no single reliable cross-browser signal, and every one of them lies
 * at a different moment:
 *
 *  - `audioTracks` is empty in Chrome until the tracks are *enabled*, even for
 *    a file that definitely has audio.
 *  - `webkitAudioDecodedByteCount` is 0 until something has decoded, so at
 *    `loadedmetadata` it means "not yet", not "absent".
 *  - `mozHasAudio` is Firefox only.
 *
 * So report three states and never collapse them into two. Announcing
 * "MUXER AND PANEL DISAGREE" about a file that plays perfectly is worse than
 * saying nothing.
 */
interface MediaFacts {
  width: number
  height: number
  duration: number
  enabledTrackCount: number
  decodedBytes: number | undefined
  mozHasAudio: boolean | undefined
}

function enableAudioTracks(video: HTMLVideoElement): void {
  const tracks = (video as HTMLVideoElement & { audioTracks?: ArrayLike<{ enabled: boolean }> }).audioTracks
  if (!tracks) return
  try {
    for (let i = 0; i < tracks.length; i++) tracks[i]!.enabled = true
  } catch {
    /* the property is read-only on some builds */
  }
}

function describe(video: HTMLVideoElement): MediaFacts {
  const anyVideo = video as HTMLVideoElement & {
    mozHasAudio?: boolean
    webkitAudioDecodedByteCount?: number
    audioTracks?: ArrayLike<unknown>
  }
  return {
    width: video.videoWidth,
    height: video.videoHeight,
    duration: Number.isFinite(video.duration) ? video.duration : 0,
    enabledTrackCount: anyVideo.audioTracks?.length ?? 0,
    decodedBytes: anyVideo.webkitAudioDecodedByteCount,
    mozHasAudio: anyVideo.mozHasAudio,
  }
}

type Verdict = 'present' | 'absent' | 'not yet confirmed'

function audioVerdict(info: MediaFacts, weAddedAudio: boolean): Verdict {
  if (info.mozHasAudio === true) return 'present'
  if (info.mozHasAudio === false) return weAddedAudio ? 'absent' : 'absent'
  if (info.decodedBytes !== undefined) {
    // Meaningful only after playback has started.
    return info.decodedBytes > 0 ? 'present' : weAddedAudio ? 'not yet confirmed' : 'absent'
  }
  if (info.enabledTrackCount > 0) return 'present'
  return weAddedAudio ? 'not yet confirmed' : 'absent'
}
