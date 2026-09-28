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
import { log } from '../dev/debug.js'

const STORAGE_KEY = 'open-editor:layout:v2'

export interface Layout {
  sidebarWidth: number
  sidebarCollapsed: boolean
  timelineHeight: number
  timelineCollapsed: boolean
  /** Size to restore on re-expand; survives a reload. */
  sidebarRestore?: number
  timelineRestore?: number
}

const DEFAULTS: Layout = {
  sidebarWidth: 236,
  sidebarCollapsed: false,
  timelineHeight: 236,
  timelineCollapsed: false,
}

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

  function save(): void {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          sidebarWidth: sidebarWidth(),
          sidebarCollapsed: sidebarCollapsed(),
          timelineHeight: timelineHeight(),
          timelineCollapsed: timelineCollapsed(),
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

  function toggleTimeline(): void {
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
    save()
  }

  return {
    sidebarWidth,
    sidebarCollapsed,
    timelineHeight,
    timelineCollapsed,
    sidebarTrack,
    timelineTrack,
    setSidebarWidth: setSidebarWidthClamped,
    setTimelineHeight: setTimelineHeightClamped,
    toggleSidebar,
    toggleTimeline,
    beginSidebarDrag,
    beginTimelineDrag,
    reset,
    save,
  }
}

export type LayoutState = ReturnType<typeof createLayout>
