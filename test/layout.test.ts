/**
 * Panel layout: clamping, collapse, and restore.
 *
 * The interesting bugs here are all "the panel is the wrong size and the user
 * has no idea why" — a handle that jumps, a collapse that forgets the width,
 * a preference file that opens the app at 4px. None of that is visible in the
 * types, so it gets assertions.
 */

import { strict as assert } from 'node:assert'
import { beforeEach, test } from 'node:test'

// A minimal localStorage, so the module under test has something to read.
const store = new Map<string, string>()
;(globalThis as { localStorage?: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage
;(globalThis as { window?: unknown }).window = {
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  innerWidth: 1440,
  innerHeight: 900,
}

const { createLayout, LIMITS, STORAGE_KEY, mainRows, PREVIEW_TRANSPORT_ONLY } = await import('../src/app/store/layout.ts')

// The layout module persists to a shared localStorage, so every test needs a
// clean one — otherwise a collapsed panel leaks into the next test and the
// assertions are about somebody else's state.
beforeEach(() => store.clear())

function pointer(x: number, y: number): PointerEvent {
  return { clientX: x, clientY: y } as PointerEvent
}

test('a fresh install gets the documented defaults', () => {
  const layout = createLayout()
  assert.equal(layout.sidebarWidth(), 236)
  assert.equal(layout.timelineHeight(), 236)
  assert.equal(layout.sidebarCollapsed(), false)
  assert.equal(layout.timelineCollapsed(), false)
})

test('a collapsed panel reports a 0px track so the grid does not re-flow', () => {
  const layout = createLayout()
  assert.equal(layout.sidebarTrack(), '236px')
  assert.equal(layout.timelineTrack(), '236px')
  layout.toggleSidebar()
  assert.equal(layout.sidebarCollapsed(), true)
  assert.equal(layout.sidebarTrack(), '0px')
  layout.toggleTimeline()
  assert.equal(layout.timelineCollapsed(), true)
  assert.equal(layout.timelineTrack(), '0px')
})

test('expanding restores the width the panel had before it collapsed', () => {
  const layout = createLayout()
  layout.setSidebarWidth(340)
  layout.setTimelineHeight(400)
  layout.toggleSidebar()
  assert.equal(layout.sidebarTrack(), '0px')
  layout.toggleSidebar()
  // Not the minimum, and not 0: the size the user actually chose.
  assert.equal(layout.sidebarWidth(), 340)
  layout.toggleTimeline()
  layout.toggleTimeline()
  assert.equal(layout.timelineHeight(), 400)
})

test('dragging a panel clamps instead of trusting the pointer', () => {
  const layout = createLayout()
  layout.setSidebarWidth(100_000)
  assert.equal(layout.sidebarWidth(), LIMITS.sidebar.max)
  layout.setSidebarWidth(-500)
  assert.equal(layout.sidebarWidth(), LIMITS.sidebar.min)
  layout.setTimelineHeight(10_000)
  assert.equal(layout.timelineHeight(), LIMITS.timeline.max)
  layout.setTimelineHeight(0)
  assert.equal(layout.timelineHeight(), LIMITS.timeline.min)
})

test('a non-numeric or absent size falls back to the default', () => {
  const layout = createLayout()
  layout.setSidebarWidth(Number.NaN)
  assert.equal(layout.sidebarWidth(), 236)
  layout.setSidebarWidth(Number.POSITIVE_INFINITY)
  assert.equal(layout.sidebarWidth(), 236)
  layout.setTimelineHeight(Number.NaN)
  assert.equal(layout.timelineHeight(), 236)
})

test('the restore size survives a reload even while collapsed', () => {
  const first = createLayout()
  first.setSidebarWidth(300)
  first.toggleSidebar() // collapsed; the live width is now irrelevant
  first.save()

  const second = createLayout()
  assert.equal(second.sidebarCollapsed(), true)
  second.toggleSidebar()
  assert.equal(second.sidebarWidth(), 300, 'a reload must not forget the width')
})

test('a corrupt preference file falls back to defaults instead of throwing', () => {
  store.set(STORAGE_KEY, '{not json')
  const layout = createLayout()
  assert.equal(layout.sidebarWidth(), 236)
  assert.equal(layout.timelineHeight(), 236)
})

test('an out-of-range persisted size is repaired on load, not applied', () => {
  store.set(
    STORAGE_KEY,
    JSON.stringify({ sidebarWidth: 99_999, timelineHeight: -40 }),
  )
  const layout = createLayout()
  assert.equal(layout.sidebarWidth(), LIMITS.sidebar.max)
  assert.equal(layout.timelineHeight(), LIMITS.timeline.min)
})

test('reset returns every panel to its default', () => {
  const layout = createLayout()
  layout.setSidebarWidth(470)
  layout.setTimelineHeight(600)
  layout.toggleSidebar()
  layout.reset()
  assert.equal(layout.sidebarWidth(), 236)
  assert.equal(layout.timelineHeight(), 236)
  assert.equal(layout.sidebarCollapsed(), false)
  assert.equal(layout.timelineCollapsed(), false)
  // And the restore values too, so a later collapse reopens at 236, not 470.
  layout.setSidebarWidth(300)
  layout.toggleSidebar()
  layout.toggleSidebar()
  assert.equal(layout.sidebarWidth(), 300)
})

test('a drag from a collapsed panel reopens it at the remembered size', () => {
  const layout = createLayout()
  layout.setSidebarWidth(320)
  layout.toggleSidebar()
  // Pressing the handle must not feel dead.
  layout.beginSidebarDrag(pointer(0, 0))
  assert.equal(layout.sidebarCollapsed(), false)
  assert.equal(layout.sidebarWidth(), 320)
})

test('the timeline handle inverts the drag: up means taller', () => {
  const layout = createLayout()
  const before = layout.timelineHeight()
  layout.beginTimelineDrag(pointer(0, 400))
  const moves: ((e: PointerEvent) => void)[] = []
  const win = globalThis.window as unknown as {
    addEventListener(type: string, fn: (e: PointerEvent) => void, once?: boolean): void
  }
  win.addEventListener = (type, fn, once) => {
    if (type === 'pointermove') moves.push(fn as (e: PointerEvent) => void)
    void once
  }
  // Re-press so the listeners are ours, then drag 50px up.
  layout.beginTimelineDrag(pointer(0, 400))
  for (const m of moves) m(pointer(0, 350))
  assert.equal(layout.timelineHeight(), before + 50)
})

test('the sidebar handle does not invert: right means wider', () => {
  const layout = createLayout()
  const before = layout.sidebarWidth()
  const moves: ((e: PointerEvent) => void)[] = []
  const win = globalThis.window as unknown as {
    addEventListener(type: string, fn: (e: PointerEvent) => void, once?: boolean): void
  }
  win.addEventListener = (type, fn, once) => {
    if (type === 'pointermove') moves.push(fn as (e: PointerEvent) => void)
    void once
  }
  layout.beginSidebarDrag(pointer(0, 0))
  for (const m of moves) m(pointer(40, 0))
  assert.equal(layout.sidebarWidth(), before + 40)
})

/**
 * Hiding the picture.
 *
 * The whole feature is one boolean and one grid string, so the tests are the
 * feature's real documentation — there is not much else to assert.
 */
test('hiding the picture leaves the transport bar, and the timeline takes the slack', () => {
  const layout = createLayout()
  assert.equal(layout.pictureHidden(), false)

  layout.togglePicture()
  assert.equal(layout.pictureHidden(), true)
  assert.equal(
    mainRows(layout.pictureHidden(), layout.timelineTrack()),
    `${PREVIEW_TRANSPORT_ONLY}px minmax(0, 1fr)`,
    'a hidden picture should leave the transport bar and give the timeline everything else',
  )

  layout.togglePicture()
  assert.equal(layout.pictureHidden(), false)
  assert.equal(
    mainRows(layout.pictureHidden(), layout.timelineTrack()),
    `minmax(0, 1fr) ${layout.timelineTrack()}`,
    'showing it again must restore the previous arrangement exactly',
  )
})

test('the picture is not restored from a size, because it never had one', () => {
  // The collapse-twice trap: a panel that remembers "0px" as its size and
  // restores *to* 0. The picture is a mode, not a size, so there is nothing to
  // get wrong — and the grid string is the only thing that changes.
  const layout = createLayout()
  layout.setTimelineHeight(300)
  const before = mainRows(layout.pictureHidden(), layout.timelineTrack())
  layout.togglePicture()
  layout.togglePicture()
  assert.equal(mainRows(layout.pictureHidden(), layout.timelineTrack()), before)
  assert.equal(layout.timelineHeight(), 300, 'hiding the picture must not disturb the timeline size')
})

test('hiding the picture with the timeline collapsed would leave nothing to edit', () => {
  const layout = createLayout()
  layout.toggleTimeline()
  assert.equal(layout.timelineCollapsed(), true)

  layout.togglePicture()
  assert.equal(
    layout.timelineCollapsed(),
    false,
    'a 48px strip with no timeline is not a view anyone asked for',
  )
})

test('the hidden picture survives a reload', () => {
  const first = createLayout()
  first.togglePicture()
  first.save()
  assert.equal(createLayout().pictureHidden(), true)
})

test('reset brings the picture back', () => {
  const layout = createLayout()
  layout.togglePicture()
  layout.reset()
  assert.equal(layout.pictureHidden(), false)
})

test('the timeline cannot be collapsed while the picture is hidden', () => {
  // They are alternatives, not a stack: hiding the picture hands the whole
  // column to the timeline, and `mainRows` ignores the timeline's own height in
  // that mode. Letting it collapse would leave a 48px strip and a button that
  // silently refuses — indistinguishable, to the user, from a click that missed.
  const layout = createLayout()
  assert.equal(layout.canCollapseTimeline(), true)

  layout.togglePicture()
  assert.equal(layout.canCollapseTimeline(), false)

  const before = mainRows(layout.pictureHidden(), layout.timelineTrack())
  layout.toggleTimeline()
  assert.equal(layout.timelineCollapsed(), false, 'it must refuse rather than half-collapse')
  assert.equal(mainRows(layout.pictureHidden(), layout.timelineTrack()), before)

  // And the media panel is still free to collapse — it has its own track.
  assert.equal(layout.canCollapseTimeline(), false)
  layout.toggleSidebar()
  assert.equal(layout.sidebarCollapsed(), true, 'hiding the picture must not freeze the other panel')
})
