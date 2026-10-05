/**
 * Preview canvas and transport.
 *
 * The preview and the exporter call the same `renderFrame`. Preview is only
 * allowed to differ in *which* source frame it fetches — never in how it is
 * drawn (docs/decisions/0001-one-render-function.md).
 */

import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js'
import type { Clip } from '../../../model/project.js'
import { renderBlank, renderFrame, type SourceImage } from '../../../render/render.js'
import type { AppState } from '../../store/state.js'
import type { ContextMenuState } from '../ui/ContextMenu.js'
import type { LayoutState } from '../../store/layout.js'
import type { Fullscreen } from '../shell/fullscreen.js'
import { log } from '../../../dev/debug.js'
import { createDiagnostics, HEALTH_INTERVAL_MS } from '../../../dev/preview-diagnostics.js'
import { Transport } from './Transport.js'
import { paintIntentAt } from './paint-intent.js'
import { usePlaybackClock } from './use-playback-clock.js'

export function Preview(props: {
  state: AppState
  menu: ContextMenuState
  layout: LayoutState
  fullscreen: Fullscreen
}) {
  const state = props.state
  let canvas!: HTMLCanvasElement

  let cachedContext: CanvasRenderingContext2D | null = null
  let contextFor: HTMLCanvasElement | null = null

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
  /**
   * The 2D context, acquired on first use.
   *
   * Not `let ctx!: CanvasRenderingContext2D`. The definite-assignment
   * assertion tells TypeScript to stop checking, so an unassigned context
   * compiles cleanly and then fails at runtime on the first `context().save()` —
   * which is exactly what happened, and it cost four rounds of debugging a
   * rendering bug that was a mistyped variable name.
   *
   * The cache is keyed on the element it came from, and that is not
   * fussiness. It used to be a bare `cachedContext`, which outlived the canvas:
   * hiding the picture unmounts the stage, `ref` rebinds `canvas` to a brand
   * new element, and the cached context still pointed at the *destroyed* one.
   * Every render after that drew into a canvas that was no longer in the
   * document — a black picture — while the health check dutifully reported
   * `canvas on-screen 0x0 display=` (empty, because getComputedStyle on a
   * detached element returns empty strings) and raised a LAYOUT fault every
   * five seconds for the rest of the session.
   */
  function context(): CanvasRenderingContext2D {
    if (!canvas) throw new Error('Preview: canvas ref was never set')
    if (cachedContext && contextFor === canvas) return cachedContext
    const acquired = canvas.getContext('2d', { alpha: false })
    if (!acquired) throw new Error('Preview: could not acquire a 2d context')
    cachedContext = acquired
    contextFor = canvas
    return acquired
  }

  const aspect = () => {
    const first = state.videoTracks().flat()[0]
    const asset = first ? state.getAsset(first.assetId) : undefined
    return asset ? asset.width / asset.height : 16 / 9
  }

  function options(): { width: number; height: number } {
    // The stage is unmounted while the picture is hidden, so the ref never ran
    // and `canvas` is undefined. Callers that legitimately run without a canvas
    // (the diagnostics) get a 0x0 viewport instead of a TypeError.
    return canvas ? { width: canvas.width, height: canvas.height } : { width: 0, height: 0 }
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
   * Why a clip cannot be decoded here, if it cannot.
   *
   * The two cases read differently on purpose. Media dropped from the library is
   * about this session — the asset was removed while a clip still points at it —
   * and a decoder that will not open is about the file. Both are faults, because
   * neither is something the user asked for, and both therefore get said out
   * loud. Everything the user *did* ask for stays silent.
   */
  const unavailable = (clip: Clip): string | null => {
    const entry = state.library.get(clip.assetId)
    if (!entry) return `media for clip ${clip.id} was dropped from the library`
    if (!entry.videoSink) return entry.error ?? 'no decoder for this clip'
    return null
  }

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
      video: state.videoClipCount(),
      audio: state.audioClipCount(),
      duration: +state.duration().toFixed(3),
    })
    drawDiagnostic()
  }

  function draw(): void {
    const t = state.playhead()
    requestedAt = t

    // Nothing to draw onto. Hiding the picture unmounts the canvas, and
    // `canvas` still points at the detached one — so without this the app
    // would keep decoding frames and "painting" them into a dead element,
    // inflating the paint counter with work nobody can see. The health check
    // calls this state out rather than treating it as a fault.
    //
    if (props.layout.pictureHidden()) {
      paintedAt = t
      return
    }

    // `!canvas` covers the hidden-at-startup case: the `<Show>` never rendered
    // the stage, so the ref never ran and `context()` would throw instead.
    if (!canvas) {
      paintedAt = t
      return
    }

    if (state.videoClipCount() === 0) {
      // Nothing to decode yet. Draw a plain black frame and let the DOM empty
      // state ("Drop a video file anywhere to begin.") speak — the canvas
      // diagnostic overlay is a developer readout, and putting it on top of the
      // first screen a user ever sees reads as a crash.
      renderBlank(context(), options())
      lastError = null
      paintedAt = t
      return
    }

    // What belongs on the canvas at `t` is decided in one place — `paintIntentAt`
    // — because it used to be decided inline in three places here and the three
    // disagreed. A hidden clip painted black; a gap and a missing decoder both
    // reported a problem and painted *nothing*, which left the previous clip's
    // last frame frozen on the canvas.
    //
    // Every blank path paints. A gap is silence the user cut, and the exporter
    // fills it with black (`emitBlankUntil`), so showing a frozen frame instead
    // was showing something the exported file does not contain (ADR-1).
    //
    // A fault explains itself on screen, because "I can see nothing here" with no
    // reason is what costs hours. A deliberate blank says nothing at all — see
    // `paint-intent.ts` on why that distinction is the point.
    function paintBlank(fault: string | null, at: number): void {
      renderBlank(context(), options())
      lastError = null
      paintedAt = at
      if (fault) explain(fault)
      else if (showDiag()) drawDiagnostic()
    }

    const intent = paintIntentAt(state.videoTracks(), t, unavailable)
    if (intent.kind === 'blank') {
      paintBlank(intent.fault, t)
      return
    }

    const loc = intent.loc
    const entry = state.library.get(loc.clip.assetId)!
    const sourceTime = intent.sourceTime
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
    // Non-null asserted, and this is the reason the decision was extracted rather
    // than re-checked here: `paintIntentAt` was handed `unavailable` as its
    // predicate and returns `decode` only when that predicate passes, so the
    // sink exists. A second `if (!sink)` would be a second answer to a question
    // that now has one owner — and a branch that can never run is a branch
    // nobody keeps true.
    void entry.videoSink!
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

        // The clip under `forTime` can have changed while this frame was decoding,
        // and the staleness check below cannot see it: hiding or deleting does not
        // move the playhead, so `requestedAt` is unchanged and the frame sails
        // through and paints straight over the black. Intermittent by nature — it
        // depends on whether the decode outlasted the keystroke.
        //
        // So the decision is asked again here, where the answer is about to matter,
        // and asked with the *same* function the draw path uses. It used to check
        // only for `hidden`, which left the other two ways a clip can stop being
        // drawable — deleted (so `forTime` is a gap now) or stripped of its
        // decoder — free to paint over the black.
        const current = paintIntentAt(state.videoTracks(), forTime, unavailable)
        if (current.kind === 'blank') {
          paintBlank(current.fault, forTime)
          return
        }
        // The lane was reordered under us and `forTime` now belongs to a different
        // clip. This frame is the old clip's; the `finally` block re-draws.
        if (current.loc.clip.id !== loc.clip.id) return

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
    const stats = diagnostics.sample(viewport.width, viewport.height)
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

  /**
   * Diagnostics, bound to this component's locals.
   *
   * The component keeps only what it alone knows — the context, the output
   * size, and three counters — and hands them over. Everything else, including
   * the wording, lives in dev/preview-diagnostics.
   */
  const diagnostics = createDiagnostics(state, {
    ctx: context,
    size: options,
    counters: () => ({ paints: frameCounter, blackFrames, luma: lastLuma }),
    lastError: () => lastError,
    inFlight: () => inFlight,
    overlayOn: showDiag,
    pictureHidden: () => props.layout.pictureHidden(),
  })

  function reportHealth(): void {
    // There is no canvas to measure while the picture is hidden — the stage is
    // unmounted and `facts()` would throw "canvas ref was never set" on every
    // interval, which is what the console was showing once every five seconds.
    if (props.layout.pictureHidden()) return
    const { info, errors } = diagnostics.health()
    for (const line of info) log.info(line)
    for (const line of errors) log.error(line)
  }
  const healthTimer = setInterval(reportHealth, HEALTH_INTERVAL_MS)
  // The health interval holds the store, so leaving it running would keep a
  // torn-down preview alive and log against a project that no longer exists.
  onCleanup(() => clearInterval(healthTimer))

  /** Last-resort readout, drawn on the canvas so it needs no devtools. */
  function drawDiagnostic(): void {
    // Blank first, so the overlay text is legible over any frame.
    renderBlank(context(), options())
    diagnostics.drawOverlay()
  }


  // Re-draw whenever the playhead, the clips, or the canvas size changes.
  createEffect(() => {
    // A hidden picture has no canvas at all: the stage is unmounted, the ref
    // never ran, and reading `canvas.width` threw
    // "Cannot read properties of undefined (reading 'width')" on every commit.
    // Tracking `pictureHidden` here means the effect re-runs and repaints when
    // the picture comes back.
    if (props.layout.pictureHidden()) return
    state.playhead()
    state.videoTracks()
    state.project.assets
    canvas.width
    draw()
    // Nothing rendered and no decode in flight means we are stuck. Say so on
    // the canvas rather than leaving a black rectangle.
    if (!inFlight && paintedAt !== state.playhead() && !lastError) drawDiagnostic()
  })

  // Hiding the picture removes the stage, so drop the fullscreen target with it.
  // Solid does not reliably call the `ref` with `null` on teardown, and a stale
  // target means the fullscreen button tries to promote a detached element.
  createEffect(() => {
    if (props.layout.pictureHidden()) props.fullscreen.register(null)
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
  const clock = usePlaybackClock(state)

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
    <div class="flex min-h-0 flex-col bg-black" data-preview>
      {/* stage — removed entirely when the picture is hidden, so the canvas is
          not merely clipped: a 0-height canvas still costs a paint, and the
          scrub handler would still be bound to it. */}
      <Show when={!props.layout.pictureHidden()}>
        <div ref={(el) => props.fullscreen.register(el)} class="relative grid min-h-0 flex-1 place-items-center overflow-hidden bg-black p-4">
        <div
          class="relative max-h-full max-w-full"
          style={{ 'aspect-ratio': String(aspect()), width: 'min(100%, calc((100cqh) * ' + aspect() + '))' }}
        >
          <canvas
            ref={canvas}
            width={1280}
            height={Math.round(1280 / aspect())}
            class="size-full cursor-col-resize rounded-md bg-black shadow-[0_0_0_1px_#23242c,0_18px_50px_-12px_#000]"
            onContextMenu={(e) => {
              e.preventDefault()
              props.menu.show({ kind: 'preview', x: e.clientX, y: e.clientY })
            }}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId)
              onScrub(e)
            }}
            onPointerMove={(e) => e.buttons === 1 && onScrub(e)}
          />

          {/* Empty state, rather than a black rectangle with no explanation. */}
          <Show when={state.videoClipCount() === 0}>
            <div class="absolute inset-0 grid place-items-center">
              <div class="max-w-[38ch] text-center">
                <p class="text-[13px] text-fg">
                  {state.assetIds().length > 0 ? (
                    <>
                      <span class="font-semibold">
                        {state.assetIds().length} file{state.assetIds().length === 1 ? '' : 's'} ready.
                      </span>{' '}
                      Double-click one under <span class="text-accent">Media</span>, or drag it onto a track.
                    </>
                  ) : (
                    'Drop a video file anywhere to begin.'
                  )}
                </p>
              </div>
            </div>
          </Show>
        </div>
      </div>
      </Show>

      <Transport
        state={state}
        ticks={clock.ticks}
        pictureHidden={props.layout.pictureHidden}
        fullscreen={props.fullscreen.active}
        onToggleFullscreen={props.fullscreen.toggle}
        onTogglePicture={() => props.layout.togglePicture()}
      />
    </div>
  )
}
