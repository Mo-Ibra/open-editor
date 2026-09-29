/**
 * Panel layout: sizes, collapse state, and the drag handles that change them.
 *
 * Kept separate from the project. Layout is a *preference* — it should survive
 * a reload even when the project does not — and mixing it into the project
 * means a project saved on a 27" monitor opens with unusable panels on a
 * laptop.
 *
 * Panel sizes live in `localStorage` rather than the IndexedDB project store
 * because they are a handful of numbers, read synchronously before first
 * paint. Waiting on an async store would make the app visibly jump.
 */

import { createSignal } from 'solid-js'
import { log } from '../../dev/debug.js'

/**
 * The preference key.
 *
 * Not bumped when `pictureHidden` was added: `load()` defaults any field the
 * stored payload omits, so a v2 payload loads into the new shape unchanged.
 * Bumping it would have silently thrown away every user's panel sizes for no
 * benefit.
 */
export const STORAGE_KEY = 'open-editor:layout:v2'

export interface Layout {
  sidebarWidth: number
  sidebarCollapsed: boolean
  timelineHeight: number
  timelineCollapsed: boolean
  /** The picture is hidden; only the transport bar remains. */
  pictureHidden: boolean
  /** Size to restore on re-expand; survives a reload. */
  sidebarRestore?: number
  timelineRestore?: number
}

const DEFAULTS: Layout = {
  sidebarWidth: 236,
  sidebarCollapsed: false,
  timelineHeight: 236,
  timelineCollapsed: false,
  pictureHidden: false,
}

/**
 * The height the preview keeps when the picture is hidden — the transport bar
 * and nothing else.
 *
 * This must stay equal to the transport's own height. It is duplicated rather
 * than measured because measuring would mean a layout read on every toggle.
 *
 * The markup uses an explicit `h-[48px]` rather than Tailwind's `h-12`, so the
 * two are the same number instead of the same number by way of `3rem` — which
 * would quietly become 39px if anyone set a root font size. `test/dom.test.ts`
 * ties the two together.
 */
export const PREVIEW_TRANSPORT_ONLY = 48

/**
 * Limits.
 *
 * The maxima are not arbitrary: the timeline is bounded by the viewport minus
 * the top bar and transport, and the sidebar by what still leaves the preview
 * enough width to judge a 16:9 frame. Below the minimums the panels stop being
 * usable, so the drag clamps rather than trusting the pointer.
 */
export const LIMITS = {
  sidebar: { min: 180, max: 480 },
  timeline: { min: 120, max: 640 },
} as const

function load(): Layout {
  const base: Layout = { ...DEFAULTS }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return base
    const parsed = JSON.parse(raw) as Partial<Layout>

    const sidebarWidth = clamp(
      Number(parsed.sidebarWidth),
      LIMITS.sidebar.min,
      LIMITS.sidebar.max,
      DEFAULTS.sidebarWidth,
    )
    const timelineHeight = clamp(
      Number(parsed.timelineHeight),
      LIMITS.timeline.min,
      LIMITS.timeline.max,
      DEFAULTS.timelineHeight,
    )

    return {
      sidebarWidth,
      sidebarCollapsed: Boolean(parsed.sidebarCollapsed),
      timelineHeight,
      timelineCollapsed: Boolean(parsed.timelineCollapsed),
      pictureHidden: Boolean(parsed.pictureHidden),
      // The restore size is what a collapsed panel opens back to. It is stored
      // separately because the live width is 0 while collapsed, and 0 is not a
      // size worth restoring to. A legacy or missing value falls back to the
      // measured width, so an old preference file still opens sanely.
      sidebarRestore: clamp(
        Number(parsed.sidebarRestore),
        LIMITS.sidebar.min,
        LIMITS.sidebar.max,
        sidebarWidth,
      ),
      timelineRestore: clamp(
        Number(parsed.timelineRestore),
        LIMITS.timeline.min,
        LIMITS.timeline.max,
        timelineHeight,
      ),
    }
  } catch {
    // A corrupt or unreadable preference must never stop the app booting.
    return base
  }
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

export function createLayout() {
  const initial = load()
  // Width/height to return to on re-expand. A collapsed panel is 0px wide, so
  // without this the user gets a 0→min jump and has to re-drag every time.
  let sidebarRestore = initial.sidebarRestore ?? initial.sidebarWidth
  let timelineRestore = initial.timelineRestore ?? initial.timelineHeight
  const [sidebarWidth, setSidebarWidth] = createSignal(initial.sidebarWidth)
  const [sidebarCollapsed, setSidebarCollapsedRaw] = createSignal(initial.sidebarCollapsed)
  const [timelineHeight, setTimelineHeight] = createSignal(initial.timelineHeight)
  const [timelineCollapsed, setTimelineCollapsedRaw] = createSignal(initial.timelineCollapsed)
  const [pictureHidden, setPictureHidden] = createSignal(initial.pictureHidden)

  function save(): void {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          sidebarWidth: sidebarWidth(),
          sidebarCollapsed: sidebarCollapsed(),
          timelineHeight: timelineHeight(),
          timelineCollapsed: timelineCollapsed(),
          pictureHidden: pictureHidden(),
          // Saved explicitly: a collapsed panel reports 0px from its track,
          // but 0 is not a width worth restoring to.
          sidebarRestore,
          timelineRestore,
        } satisfies Layout),
      )
    } catch (err) {
      // Private browsing, quota, or a disabled store. Not worth interrupting for.
      log.debug('layout could not be saved', String(err))
    }
  }

  function setSidebarWidthClamped(value: number): void {
    setSidebarWidth(clamp(value, LIMITS.sidebar.min, LIMITS.sidebar.max, DEFAULTS.sidebarWidth))
  }

  function setTimelineHeightClamped(value: number): void {
    setTimelineHeight(clamp(value, LIMITS.timeline.min, LIMITS.timeline.max, DEFAULTS.timelineHeight))
  }

  function toggleSidebar(): void {
    if (sidebarCollapsed()) {
      setSidebarWidth(sidebarRestore)
      setSidebarCollapsedRaw(false)
    } else {
      sidebarRestore = sidebarWidth()
      setSidebarCollapsedRaw(true)
    }
    save()
    log.debug(`sidebar ${sidebarCollapsed() ? 'collapsed' : 'expanded'}`)
  }

  /**
   * Whether the timeline may be collapsed at all.
   *
   * It may not, while the picture is hidden. `mainRows()` hands the whole column
   * to the timeline in that mode, and it ignores `timelineTrack()` entirely — so
   * collapsing it would leave a 48px strip and a dead button, with no way to
   * tell that from a click that did not land. The two panels are alternatives
   * here, not a stack: one of them has to have the room.
   */
  const canCollapseTimeline = (): boolean => !pictureHidden()

  function toggleTimeline(): void {
    if (!canCollapseTimeline()) {
      log.debug('timeline collapse refused — the picture is hidden and the timeline owns the column')
      return
    }
    if (timelineCollapsed()) {
      setTimelineHeight(timelineRestore)
      setTimelineCollapsedRaw(false)
    } else {
      timelineRestore = timelineHeight()
      setTimelineCollapsedRaw(true)
    }
    save()
    log.debug(`timeline ${timelineCollapsed() ? 'collapsed' : 'expanded'}`)
  }

  /**
   * Hide the picture, or bring it back.
   *
   * Hiding keeps the transport bar, deliberately. "Hide the video" is a request
   * for more timeline, not for a way to stop playing — collapsing the whole
   * preview would take the play button with it, and the user would be left with
   * a timeline and no way to hear what they are cutting.
   *
   * It also refuses to leave the app with nothing to work in: hiding the picture
   * while the timeline is collapsed would leave a 48px strip and no timeline, so
   * the timeline is expanded on the way through.
   */
  function togglePicture(): void {
    const next = !pictureHidden()
    if (next && timelineCollapsed()) setTimelineCollapsedRaw(false)
    setPictureHidden(next)
    save()
    log.debug(`picture ${next ? 'hidden' : 'shown'}`)
  }

  // --- dragging ------------------------------------------------------------

  function beginSidebarDrag(event: PointerEvent): void {
    const startX = event.clientX
    const startWidth = sidebarWidth()
    let moved = false

    const onMove = (e: PointerEvent) => {
      moved = true
      sidebarRestore = clamp(startWidth + (e.clientX - startX), LIMITS.sidebar.min, LIMITS.sidebar.max, sidebarRestore)
      setSidebarWidthClamped(sidebarRestore)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (moved) {
        // Expanding on release if the drag was a click: one gesture, both results.
        if (sidebarCollapsed()) setSidebarCollapsedRaw(false)
        save()
      }
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
    // Dragging from a collapsed sidebar should open it, or the drag appears dead.
    if (sidebarCollapsed()) {
      setSidebarCollapsedRaw(false)
      setSidebarWidth(sidebarRestore)
    }
  }

  function beginTimelineDrag(event: PointerEvent): void {
    const startY = event.clientY
    const startHeight = timelineHeight()
    let moved = false

    const onMove = (e: PointerEvent) => {
      moved = true
      // The handle sits above the panel, so dragging up makes it taller.
      timelineRestore = clamp(startHeight - (e.clientY - startY), LIMITS.timeline.min, LIMITS.timeline.max, timelineRestore)
      setTimelineHeightClamped(timelineRestore)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (moved) {
        if (timelineCollapsed()) setTimelineCollapsedRaw(false)
        save()
      }
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp, { once: true })
    if (timelineCollapsed()) {
      setTimelineCollapsedRaw(false)
      setTimelineHeight(timelineRestore)
    }
  }

  // --- derived, for inline styles -----------------------------------------

  /** The collapsed width is 0, not hidden, so the grid never re-flows. */
  const sidebarTrack = (): string => (sidebarCollapsed() ? '0px' : `${sidebarWidth()}px`)
  const timelineTrack = (): string => (timelineCollapsed() ? '0px' : `${timelineHeight()}px`)

  function reset(): void {
    sidebarRestore = DEFAULTS.sidebarWidth
    timelineRestore = DEFAULTS.timelineHeight
    setSidebarWidth(DEFAULTS.sidebarWidth)
    setSidebarCollapsedRaw(false)
    setTimelineHeight(DEFAULTS.timelineHeight)
    setTimelineCollapsedRaw(false)
    setPictureHidden(false)
    save()
  }

  return {
    sidebarWidth,
    sidebarCollapsed,
    timelineHeight,
    timelineCollapsed,
    pictureHidden,
    canCollapseTimeline,
    sidebarTrack,
    timelineTrack,
    setSidebarWidth: setSidebarWidthClamped,
    setTimelineHeight: setTimelineHeightClamped,
    toggleSidebar,
    toggleTimeline,
    togglePicture,
    beginSidebarDrag,
    beginTimelineDrag,
    reset,
    save,
  }
}

/**
 * The grid rows for the preview + timeline column.
 *
 * A pure function so the two layouts can be asserted without a DOM. It lives
 * here rather than in `App.tsx` because "what does the grid look like when the
 * picture is hidden" is layout policy, not rendering.
 *
 * With the picture shown, the preview takes the slack and the timeline keeps the
 * height it was dragged to. With the picture hidden, the preview is reduced to
 * its transport bar and the timeline takes *everything* — which is the entire
 * point of hiding it.
 */
export function mainRows(pictureHidden: boolean, timelineTrack: string): string {
  return pictureHidden ? `${PREVIEW_TRANSPORT_ONLY}px minmax(0, 1fr)` : `minmax(0, 1fr) ${timelineTrack}`
}

export type LayoutState = ReturnType<typeof createLayout>
