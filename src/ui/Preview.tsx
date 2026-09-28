/**
 * Preview canvas and transport.
 *
 * The preview and the exporter call the same `renderFrame`. Preview is only
 * allowed to differ in *which* source frame it fetches — never in how it is
 * drawn (PLAN.md ADR-1).
 */

import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js'
import { clipAtLane, sourceTimeAt } from '../project.js'
import { renderBlank, renderFrame, type SourceImage } from '../render.js'
import type { AppState } from '../state.js'
import { log } from '../debug.js'

export function Preview(props: { state: AppState }) {
  const state = props.state
  let canvas!: HTMLCanvasElement
  let cachedContext: CanvasRenderingContext2D | null = null

  /**
   * The 2D context, acquired on first use.
   *
   * Not `let ctx!: CanvasRenderingContext2D`. The definite-assignment
   * assertion tells TypeScript to stop checking, so an unassigned context
   * compiles cleanly and then fails at runtime on the first `context().save()` —
   * which is exactly what happened, and it cost four rounds of debugging a
   * symptom (black canvas) two modules away from the cause.
   *
   * A missing ref or a refused context is now a message that names itself.
   */
  function context(): CanvasRenderingContext2D {
    if (cachedContext) return cachedContext
    if (!canvas) throw new Error('Preview: canvas ref was never set')
    const acquired = canvas.getContext('2d', { alpha: false })
    if (!acquired) throw new Error('Preview: could not acquire a 2d context')
    cachedContext = acquired
    return acquired
  }

  const aspect = () => {
    const first = state.project.video[0]
    const asset = first ? state.getAsset(first.assetId) : undefined
    return asset ? asset.width / asset.height : 16 / 9
  }

  function options() {
    return { width: canvas.width, height: canvas.height }
  }

  /**
   * Draw the frame covering the playhead.
   *
   * Decode is async and there is exactly one of these in flight at a time.
   * That guard is the whole point of this function:
   *
   * Without it, every playhead tick fires a fresh getCanvas(). A seek into a
   * long, sparse-keyframe file is slow, so requests queue, the main thread
   * saturates, and the playback timer never gets a slot — the playhead appears
   * frozen and the canvas stays black. The clock was never broken; it was being
   * starved by our own decodes.
   *
   * And every result is checked against the playhead it was requested for.
   * A frame that arrives after the playhead has moved on is discarded rather
   * than painted, so a fast scrub shows the current position instead of a
   * slideshow of stale frames.
   */
  let inFlight = false
  let lastTraceAt = 0
  let requestedAt = -1
  let paintedAt = -1
  let lastError: string | null = null
  const [showDiag, setShowDiag] = createSignal(false)

  /**
   * Every way this can end up blank goes through here, and every one of them
   * reports.
   *
   * The previous version marked blank paths as "painted", which is what kept
   * the diagnostic from ever appearing — a failure to decode and a deliberate
   * black frame looked identical, and both were a silent black rectangle. If
   * the user cannot see a video, the tool owes them an explanation on screen,
   * not a black square.
   */
  let lastExplainAt = 0
  let explainCount = 0

  /**
   * Every blank path reports, but a *repeating* condition reports once.
   *
   * An unbounded loop of warnings is not a diagnostic, it is a denial of
   * service: one bad playhead position produced ~500 log beacons per second
   * and took the tab down with it.
   */
  function explain(reason: string): void {
    lastError = reason
    const nowMs = performance.now()
    if (nowMs - lastExplainAt < 2000) {
      explainCount++
      if (explainCount % 30 !== 0) return
      lastExplainAt = nowMs
      log.warn(`BLANK — ${reason} (suppressed ${explainCount - 1} repeats)`)
      return
    }
    lastExplainAt = nowMs
    explainCount = 1
    log.warn(`BLANK — ${reason}`, {
      playhead: +state.playhead().toFixed(3),
      video: state.project.video.length,
      audio: state.project.audio.length,
      duration: +state.duration().toFixed(3),
    })
    drawDiagnostic()
  }

  function draw(): void {
    const t = state.playhead()
    requestedAt = t

    if (state.project.video.length === 0) {
      explain('timeline is empty — add a clip first')
      return
    }

    const loc = clipAtLane(state.project.video, t)
    if (!loc) {
      explain(`playhead ${t.toFixed(2)}s is past the end of the timeline (${state.duration().toFixed(2)}s)`)
      return
    }

    const entry = state.library.get(loc.clip.assetId)
    if (!entry) {
      explain(`media for clip ${loc.index} was dropped from the library`)
      return
    }
    if (!entry.videoSink) {
      explain(entry.error ?? 'no decoder for this clip')
      return
    }

    const sourceTime = sourceTimeAt(loc, t)
    const now = performance.now()
    if (now - lastTraceAt > 400) {
      lastTraceAt = now
      log.debug(`draw t=${t.toFixed(3)} → clip ${loc.index}, source ${sourceTime.toFixed(3)}s`, {
        clipIn: +loc.clip.in.toFixed(3),
        clipOut: +loc.clip.out.toFixed(3),
        assetDuration: +entry.asset.duration.toFixed(3),
        cached: state.frameCache.find(sourceTime) ? 'hit' : 'miss',
        inFlight,
      })
    }

    // A held frame covers this time. Repaint it and skip the decode entirely.
    const cached = state.frameCache.find(sourceTime)
    if (cached) {
      paint(cached.canvas, loc.clip)
      lastError = null
      paintedAt = t
      if (showDiag()) drawDiagnostic()
      return
    }

    if (inFlight) return // a decode is running; it will catch up

    inFlight = true
    const forTime = t

    const started = performance.now()
    void entry.videoSink
      .getCanvas(sourceTime)
      .then((wrapped) => {
        if (wrapped) {
          log.debug(
            `decoded source ${sourceTime.toFixed(3)}s → frame ${wrapped.timestamp.toFixed(3)}s ` +
              `(+${wrapped.duration.toFixed(3)}s) ${wrapped.canvas.width}x${wrapped.canvas.height} ` +
              `in ${(performance.now() - started).toFixed(0)}ms`,
          )
        }
        if (!wrapped) {
          // Before the track's first timestamp is a legitimate answer, not a
          // failure — mediabunny documents getCanvas as returning null for it.
          if (sourceTime < 0) {
            renderBlank(context(), options())
            paintedAt = forTime
            return
          }
          explain(
            `decoder returned no frame at source ${sourceTime.toFixed(2)}s ` +
              `(${entry.asset.name}, ${entry.asset.duration.toFixed(1)}s long)`,
          )
          return
        }
        // Cache the frame FIRST, unconditionally.
        //
        // A frame is identified by the source time it covers, so it stays
        // valid however long the decode took. Discarding it because the
        // playhead moved in the meantime throws away perfectly good data —
        // and because the cache was never populated, every subsequent tick
        // missed and asked for another decode. The result was ~150 successful
        // decodes and 3 paints: correct frames, all thrown away.
        //
        // Staleness governs the *paint*, never the *cache*.
        state.frameCache.put({
          timestamp: wrapped.timestamp,
          duration: wrapped.duration,
          canvas: wrapped.canvas,
        })

        // A frame from the past is still right for that moment; it is just no
        // longer what the playhead is pointing at. The finally block re-draws.
        if (requestedAt !== forTime) {
          log.debug(`stale frame for ${forTime.toFixed(3)}s discarded (now ${requestedAt.toFixed(3)}s) — cached`)
          return
        }

        paint(wrapped.canvas, loc.clip)
        lastError = null
        paintedAt = forTime
        if (showDiag()) drawDiagnostic()
      })
      .catch((err: unknown) => {
        explain(`decode threw: ${err instanceof Error ? err.message : String(err)}`)
        console.error('[preview] decode failed', err)
      })
      .finally(() => {
        inFlight = false
        if (paintedAt !== requestedAt) draw()
      })
  }

  function paint(
    canvasLike: HTMLCanvasElement | OffscreenCanvas,
    clip: { transform?: { scale: number; x: number; y: number } },
  ): void {
    const source: SourceImage = { image: canvasLike, width: canvasLike.width, height: canvasLike.height }
    if (source.width === 0 || source.height === 0) {
      explain(`decoded frame has no pixels (${source.width}x${source.height})`)
      return
    }
    const viewport = options()
    const fit = Math.min(viewport.width / source.width, viewport.height / source.height)
    renderFrame(context(), source, clip, viewport)

    // Measure what actually landed on the canvas.
    //
    // This separates two problems that look identical from the outside: our
    // renderer failing, and the source genuinely being black. A screen
    // recording of a dark or blank screen decodes to black frames — correct
    // output, useless video — and no amount of render debugging will change it.
    const stats = measure(viewport.width, viewport.height)
    log.debug(
      `paint ${source.width}x${source.height} → ${viewport.width}x${viewport.height} ` +
        `fit=${fit.toFixed(4)} draw=${(source.width * fit).toFixed(0)}x${(source.height * fit).toFixed(0)} ` +
        `luma max=${stats.max} mean=${stats.mean}`,
    )
    lastLuma = stats
    frameCounter++
    if (stats.max === 0) blackFrames++
  }

  /**
   * Sample the painted canvas. Cheap, sparse, and decisive.
   *
   * If `max` is 0 then nothing was drawn — either the render path is broken or
   * the source frame is genuinely black. Reading the pixels settles which.
   */
  let lastLuma = { max: 0, mean: 0 }
  let blackFrames = 0
  let frameCounter = 0

  function measure(w: number, h: number): { max: number; mean: number } {
    try {
      const c = context()
      // A sparse grid beats getImageData over the whole canvas: a few
      // kilobytes instead of several megabytes, sixty times a second.
      const data = c.getImageData(0, 0, w, h).data
      let max = 0
      let sum = 0
      let n = 0
      const stride = 4 * 64
      for (let i = 0; i < data.length; i += stride) {
        const luma = (data[i]! + data[i + 1]! + data[i + 2]!) / 3
        if (luma > max) max = luma
        sum += luma
        n++
      }
      return { max: Math.round(max), mean: n ? Math.round(sum / n) : 0 }
    } catch (err) {
      log.warn('getImageData failed', String(err))
      return { max: -1, mean: -1 }
    }
  }

  /** Liveness summary, logged on a timer so it is readable. */
  function reportHealth(): void {
    // Layout matters as much as pixels. Drawing correct frames to a canvas that
    // has collapsed to 0x0 on screen is indistinguishable from a black video,
    // and "the video is black" is a conclusion you should never have to infer
    // from silence.
    const rect = canvas.getBoundingClientRect()
    const style = getComputedStyle(canvas)
    log.info(
      `health: ${frameCounter} paints, ${blackFrames} fully black, ` +
        `last luma max=${lastLuma.max} mean=${lastLuma.mean}, cache=${state.frameCache.size} frames`,
    )
    log.info(`audio: ${JSON.stringify(state.audio.describe())}`)
    log.info(
      `layout: canvas on-screen ${Math.round(rect.width)}x${Math.round(rect.height)} ` +
        `at ${Math.round(rect.left)},${Math.round(rect.top)}  ` +
        `display=${style.display} visibility=${style.visibility} opacity=${style.opacity}`,
    )
    if (rect.width < 2 || rect.height < 2) {
      log.error('LAYOUT: the canvas has no size on screen — nothing can be visible, however correct the pixels are')
    }
  }
  const healthTimer = setInterval(reportHealth, 5000)

  /** Last-resort readout, drawn on the canvas so it needs no devtools. */
  function drawDiagnostic(): void {
    const t = state.playhead()
    const loc = clipAtLane(state.project.video, t)
    const clip = loc?.clip
    const asset = clip ? state.getAsset(clip.assetId) : undefined
    const entry = clip ? state.library.get(clip.assetId) : undefined

    renderBlank(context(), options())
    const cached = loc && entry?.videoSink ? state.frameCache.find(sourceTimeAt(loc, t)) : undefined
    const lines = [
      `t=${t.toFixed(2)}   clip=${loc ? loc.index : 'none'}   ${inFlight ? 'decoding…' : 'idle'}   ${showDiag() ? '[D] overlay on' : '[D] overlay'}`,
      `asset  ${asset ? `${asset.name}  ${asset.width}x${asset.height} ${asset.videoCodec}` : 'none'}`,
      `clip   in=${loc ? loc.clip.in.toFixed(2) : '—'}s out=${loc ? loc.clip.out.toFixed(2) : '—'}s  (source t=${loc ? sourceTimeAt(loc, t).toFixed(2) : '—'}s)`,
      `decoder ${entry?.videoSink ? 'ready' : 'MISSING'}${entry?.error ? ` — ${entry.error}` : ''}`,
      `canvas  ${cached ? `${cached.canvas.width}x${cached.canvas.height}` : 'nothing cached yet'}`,
      `viewport ${options().width}x${options().height}`,
      `pixels  max=${lastLuma.max} mean=${lastLuma.mean} (0 = nothing was drawn)`,
      lastError ? `PROBLEM  ${lastError}` : 'ok',
    ]

    context().save()
    context().fillStyle = '#000'
    context().fillRect(0, 0, options().width, options().height)
    context().fillStyle = '#8ab4ff'
    context().font = '16px ui-monospace, monospace'
    context().textBaseline = 'top'
    lines.forEach((line, i) => context().fillText(line, 16, 16 + i * 22))
    context().restore()
  }

  // Re-draw whenever the playhead, the clips, or the canvas size changes.
  createEffect(() => {
    state.playhead()
    state.project.video
    state.project.audio
    state.project.assets
    canvas.width
    draw()
    // Nothing rendered and no decode in flight means we are stuck. Say so on
    // the canvas rather than leaving a black rectangle.
    if (!inFlight && paintedAt !== state.playhead() && !lastError) drawDiagnostic()
  })

  /**
   * Playback clock.
   *
   * Deliberately NOT requestAnimationFrame.
   *
   * rAF is suspended whenever the page is not being painted — background tab,
   * minimised window, or a devtools panel that took focus. A video editor is
   * exactly the app where the user has devtools open, so making rAF load-bearing
   * for the *clock* means playback silently does nothing: `playing` flips true,
   * no frame ever arrives, and the symptom is indistinguishable from a broken
   * button.
   *
   * So: the clock is wall-clock time on a timer, and the canvas repaints
   * reactively from the playhead. Timers are throttled when hidden but they
   * still fire, so playback resumes correctly and stays in step with real time
   * because every step is computed from `performance.now()`, not accumulated.
   */
  const [ticks, setTicks] = createSignal(0)
  let timer: ReturnType<typeof setInterval> | undefined

  function stopClock(): void {
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }

  createEffect(() => {
    if (!state.playing()) {
      stopClock()
      setTicks(0)
      return
    }

    // This interval does NOT own the clock. It only polls it: `advanceClock`
    // reads the AudioContext time (the reference) and falls back to
    // wall-clock only if audio never started. A JS timer is not accurate
    // enough to be the timebase for a 10-minute edit — it drifts, and the
    // drift is exactly A/V desync.
    timer = setInterval(() => {
      const previous = state.playhead()
      state.advanceClock()

      if (state.playhead() >= state.duration() && state.playing()) {
        state.seek(state.duration())
        state.setPlaying(false)
        return
      }
      if (state.playhead() !== previous) setTicks((n) => n + 1)
    }, 1000 / 120)
  })

  onCleanup(() => {
    stopClock()
    clearInterval(healthTimer)
  })

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'd' || e.key === 'D') {
        const target = e.target as HTMLElement
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return
        setShowDiag((v) => !v)
        draw()
      }
    }
    window.addEventListener('keydown', onKey)
    onCleanup(() => window.removeEventListener('keydown', onKey))
  })

  // Being hidden throttles timers to about 1 Hz, so playback becomes a slideshow
  // rather than stopping. Say so, because "it went choppy" reads as a bug.
  onMount(() => {
    const warn = () => {
      if (state.playing() && document.hidden) {
        console.warn('[transport] tab hidden — timers throttled to ~1 Hz, playback will stutter')
      }
    }
    document.addEventListener('visibilitychange', warn)
    onCleanup(() => document.removeEventListener('visibilitychange', warn))
  })

  function onScrub(event: PointerEvent): void {
    const rect = canvas.getBoundingClientRect()
    const frac = (event.clientX - rect.left) / rect.width
    state.seek(frac * state.duration())
  }

  return (
    <div class="preview">
      <div class="preview-stage" style={{ 'aspect-ratio': String(aspect()) }}>
        <canvas
          ref={canvas}
          width={1280}
          height={Math.round(1280 / aspect())}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId)
            onScrub(e)
          }}
          onPointerMove={(e) => e.buttons === 1 && onScrub(e)}
        />
      </div>

      <div class="transport">
        <button
          onClick={() => state.togglePlay()}
          title={state.duration() > 0 ? 'Play / pause (space)' : 'Add a clip to the timeline first'}
        >
          {state.playing() ? '❚❚' : '▶'}
        </button>
        <button onClick={() => state.step(-1)} title="Previous frame (←)">◀|</button>
        <button onClick={() => state.step(1)} title="Next frame (→)">|▶</button>
        <button
          classList={{ muted: state.audio.isMuted }}
          title={state.audio.isMuted ? 'Unmute (M)' : 'Mute (M)'}
          onClick={() => state.audio.setMuted(!state.audio.isMuted)}
        >
          {state.audio.isMuted ? '🔇' : '🔊'}
        </button>

        <span class="time">
          {formatTime(state.playhead())} <span class="dim">/ {formatTime(state.duration())}</span>
        </span>

        <span class="spacer" />

        <span class="debug" title="playback state — tick count proves the rAF loop is running">
          {state.project.video.length} video · {state.project.audio.length} audio
          {' · '}
          {state.playing() ? `playing (${ticks()} frames)` : 'stopped'}
          {' · '}
          ph {state.playhead().toFixed(3)}
        </span>


        <label class="zoom">
          zoom
          <input
            type="range"
            min="10"
            max="400"
            step="10"
            value={state.zoom()}
            onInput={(e) => state.setZoom(Number(e.currentTarget.value))}
          />
        </label>
      </div>

      <Show when={state.project.video.length === 0}>
        <div class="empty">
          <Show
            when={state.assetIds().length > 0}
            fallback={<p>Drop a video file anywhere to begin.</p>}
          >
            <p>
              <strong>{state.assetIds().length} file{state.assetIds().length === 1 ? '' : 's'} ready.</strong>{' '}
              Click one under <em>Media</em> to put it on the timeline.
            </p>
          </Show>
        </div>
      </Show>
    </div>
  )
}

function formatTime(seconds: number): string {
  const s = Math.max(0, seconds)
  const m = Math.floor(s / 60)
  const rest = s - m * 60
  return `${m}:${rest.toFixed(2).padStart(5, '0')}`
}
