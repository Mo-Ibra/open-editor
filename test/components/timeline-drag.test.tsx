/**
 * The move gesture, end to end, through the real handler.
 *
 * The model tests prove `placeClip` clamps. The `dom.test.ts` guard proves the
 * handler *calls* it. This drives the actual pointer handler against a rendered
 * lane and asserts the visible result — which is the only layer a user sees.
 *
 * The bug it pins: dragging a clip left used to reorder it past its neighbour,
 * so the neighbour jumped to the far side of the lane and the clip that was on
 * the left appeared to be destroyed.
 */

import { describe, expect, it } from 'vitest'
import { fireEvent, render } from '@solidjs/testing-library'

const noop = (): undefined => undefined
const g = globalThis as Record<string, unknown>
g.window ??= { addEventListener: noop, removeEventListener: noop }
g.indexedDB ??= { open: () => ({ onsuccess: noop, onerror: noop, onupgradeneeded: noop, result: {} }) }
g.IDBKeyRange ??= { bound: () => noop }
g.crypto ??= { randomUUID: () => 'x' }

const { createAppState } = await import('../../src/app/store/state.js')
const { Lane } = await import('../../src/app/view/timeline/Lane.js')
const { useTimelineDrag } = await import('../../src/app/view/timeline/use-timeline-drag.js')
const { clipStart } = await import('../../src/model/project.js')

type State = ReturnType<typeof createAppState>

const asset = {
  id: 'a', name: 'a.mp4', duration: 40, width: 1920, height: 1080, rotation: 0,
  frameRate: 30, variableFrameRate: false, hasVideo: true, hasAudio: false,
  audioSampleRate: 48000, audioChannels: 2, videoCodec: 'avc', audioCodec: 'aac', size: 1,
}

async function seed(state: State): Promise<void> {
  const file = {
    format: 'open-editor.project',
    formatVersion: 1,
    name: 't',
    savedAt: 0,
    project: {
      version: 2,
      assets: { a: asset },
      video: [
        { id: 'A', lane: 'video', assetId: 'a', in: 0, out: 10 },
        { id: 'B', lane: 'video', assetId: 'a', in: 0, out: 10 },
      ],
      audio: [],
    },
    media: {},
  }
  try {
    await state.projects.importText(JSON.stringify(file))
  } catch {
    // The project is written before importText's storage tail.
  }
}

function Harness(props: { state: State }) {
  let track!: HTMLDivElement
  const menu = { show: noop, close: noop, open: () => null } as never
  const drag = useTimelineDrag(props.state, menu, { track: () => track, scroller: () => undefined })
  return (
    <div
      ref={track}
      onPointerDown={drag.onPointerDown}
      onPointerMove={drag.onPointerMove}
      onPointerUp={drag.onPointerUp}
    >
      <Lane
        lane="video"
        label="video"
        state={props.state}
        height={80}
        dropAt={() => null}
        setDropAt={() => {}}
        trackLeft={() => 0}
      />
    </div>
  )
}

const startOf = (state: State, id: string): number => {
  const i = state.project.video.findIndex((c) => c.id === id)
  return clipStart(state.project.video, i)
}

describe('moving a clip by dragging', () => {
  it('never crosses the clip on its left — it clamps and the neighbour stays', async () => {
    const state = createAppState()
    await seed(state)
    state.setZoom(80)
    state.setClipSnap(false)
    state.setLaneSnap(false)

    const { container } = render(() => <Harness state={state} />)
    const clip = container.querySelector('[data-clip-id="B"]') as HTMLElement
    expect(clip).toBeTruthy()

    // Press inside B (which starts at 10s → 800px, so 1000px is 12.5s) and drag
    // left to 5s (400px), well past A's end.
    fireEvent.pointerDown(clip, { clientX: 1000, pointerId: 1 })
    fireEvent.pointerMove(container.firstElementChild as HTMLElement, { clientX: 400, pointerId: 1 })
    fireEvent.pointerUp(container.firstElementChild as HTMLElement, { pointerId: 1 })

    expect(startOf(state, 'A')).toBe(0)
    expect(startOf(state, 'B')).toBe(10)
    expect(state.project.video.map((c) => c.id)).toEqual(['A', 'B'])
  })

  it('leaves the clip after it put when dragged right into it', async () => {
    const state = createAppState()
    await seed(state)
    state.setZoom(80)
    state.setClipSnap(false)
    state.setLaneSnap(false)

    const { container } = render(() => <Harness state={state} />)
    const clip = container.querySelector('[data-clip-id="A"]') as HTMLElement
    const track = container.firstElementChild as HTMLElement

    // Grab A at its head (0s) and drag it to 3s (240px). B is flush at 10s, so A
    // is walled in and neither clip moves.
    fireEvent.pointerDown(clip, { clientX: 0, pointerId: 1 })
    fireEvent.pointerMove(track, { clientX: 240, pointerId: 1 })
    fireEvent.pointerUp(track, { pointerId: 1 })

    expect(startOf(state, 'A')).toBe(0)
    expect(startOf(state, 'B')).toBe(10)
  })
})

describe('the fixes from the gesture audit', () => {
  it('does not commit undo or edit on a sub-threshold jitter', async () => {
    const state = createAppState()
    await seed(state)
    state.setZoom(80)
    state.setClipSnap(false)
    state.setLaneSnap(false)

    const { container } = render(() => <Harness state={state} />)
    const clip = container.querySelector('[data-clip-id="B"]') as HTMLElement
    const track = container.firstElementChild as HTMLElement
    expect(state.canUndo()).toBe(false)

    // Press B and move it 2px — above a click, below the drag threshold.
    fireEvent.pointerDown(clip, { clientX: 1000, pointerId: 1 })
    fireEvent.pointerMove(track, { clientX: 1002, pointerId: 1 })
    fireEvent.pointerUp(track, { pointerId: 1 })

    expect(startOf(state, 'B')).toBe(10) // did not move
    expect(state.canUndo()).toBe(false) // no phantom undo entry

    // A real drag past the threshold still commits exactly once.
    fireEvent.pointerDown(clip, { clientX: 1000, pointerId: 1 })
    fireEvent.pointerMove(track, { clientX: 1240, pointerId: 1 })
    fireEvent.pointerMove(track, { clientX: 1480, pointerId: 1 })
    fireEvent.pointerUp(track, { pointerId: 1 })
    expect(state.canUndo()).toBe(true)
    expect(startOf(state, 'B')).toBe(16) // B is last, so it moved freely
  })

  it('ignores a non-primary button', async () => {
    const state = createAppState()
    await seed(state)
    state.setZoom(80)
    state.setClipSnap(false)
    state.setLaneSnap(false)
    expect(state.playhead()).toBe(0)

    const { container } = render(() => <Harness state={state} />)
    const clip = container.querySelector('[data-clip-id="B"]') as HTMLElement
    const track = container.firstElementChild as HTMLElement

    // Right-press and drag. Without a button guard this moved the clip and the
    // playhead; now it must do neither.
    fireEvent.pointerDown(clip, { clientX: 1000, pointerId: 1, button: 2 })
    fireEvent.pointerMove(track, { clientX: 400, pointerId: 1, button: 2 })
    fireEvent.pointerUp(track, { pointerId: 1, button: 2 })

    expect(startOf(state, 'B')).toBe(10) // a right-drag must not move a clip
    expect(state.playhead(), 'a right-press must not seek').toBe(0)
    expect(state.canUndo()).toBe(false)
  })

  it('previews a trim-out on the timeline, not the source time', async () => {
    const state = createAppState()
    await seed(state)
    state.setZoom(80)
    state.setClipSnap(false)
    state.setLaneSnap(false)

    const { container } = render(() => <Harness state={state} />)
    // B spans timeline 10–20 (source in 0, out 10). Its out handle is at 1600px.
    const outHandle = container.querySelector('[data-clip-id="B"] [data-handle="out"]') as HTMLElement
    const track = container.firstElementChild as HTMLElement

    fireEvent.pointerDown(outHandle, { clientX: 1600, pointerId: 1 })
    fireEvent.pointerMove(track, { clientX: 1360, pointerId: 1 }) // timeline 17
    fireEvent.pointerUp(track, { pointerId: 1 })

    expect(state.project.video[1]!.out).toBeCloseTo(7, 9)
    // The playhead must sit one frame before timeline 17, not at source 7.
    expect(state.playhead()).toBeCloseTo(17 - 1 / 30, 9)
  })

  it('previews a trim-in at the clip start, where the new in-frame now sits', async () => {
    const state = createAppState()
    await seed(state)
    state.setZoom(80)
    state.setClipSnap(false)
    state.setLaneSnap(false)

    const { container } = render(() => <Harness state={state} />)
    // B's in handle is at its start, timeline 10 → 800px.
    const inHandle = container.querySelector('[data-clip-id="B"] [data-handle="in"]') as HTMLElement
    const track = container.firstElementChild as HTMLElement

    fireEvent.pointerDown(inHandle, { clientX: 800, pointerId: 1 })
    fireEvent.pointerMove(track, { clientX: 960, pointerId: 1 }) // timeline 12
    fireEvent.pointerUp(track, { pointerId: 1 })

    expect(state.project.video[1]!.in).toBeCloseTo(2, 9)
    // The new in frame sits at the clip's start (timeline 10), not at source 2.
    expect(state.playhead()).toBeCloseTo(10, 9)
  })
})

describe('frozen snap targets across lanes', () => {
  it("does not snap to the other lane's pushed successor at its old position", async () => {
    const state = createAppState()
    const file = {
      format: 'open-editor.project',
      formatVersion: 1,
      name: 't',
      savedAt: 0,
      project: {
        version: 2,
        assets: { a: { ...asset, hasAudio: true } },
        // A linked pair, plus an unselected audio clip whose start is the bait.
        video: [{ id: 'V', lane: 'video', assetId: 'a', in: 0, out: 10, linkId: 'L' }],
        audio: [
          { id: 'A0', lane: 'audio', assetId: 'a', in: 0, out: 10, linkId: 'L' },
          { id: 'A1', lane: 'audio', assetId: 'a', in: 0, out: 10, offset: 10 }, // timeline 20..30
        ],
      },
      media: {},
    }
    try {
      await state.projects.importText(JSON.stringify(file))
    } catch {
      // project already written
    }
    state.setZoom(80)
    state.setClipSnap(false) // same-lane targets off
    state.setLaneSnap(true) // other-lane targets on — A1 is one

    const { container } = render(() => <Harness state={state} />)
    const v = container.querySelector('[data-clip-id="V"]') as HTMLElement
    const track = container.firstElementChild as HTMLElement

    // Select the linked pair, so the drag is a cross-lane group shift and A1 is
    // pushed along with it.
    state.selectClip('V')
    state.selectClip('A0', 'toggle')
    expect(state.selectionCount()).toBe(2)

    // Grab V at its head and drag so its end lands at 20.05 — just inside the
    // snap radius of A1's *old* start (20). While that frozen edge is in the
    // target list the drag snaps to 20 (start 10); with both lanes' moving clips
    // excluded it stays at 10.05.
    fireEvent.pointerDown(v, { clientX: 0, pointerId: 1 })
    fireEvent.pointerMove(track, { clientX: 804, pointerId: 1 })
    fireEvent.pointerUp(track, { pointerId: 1 })

    expect(startOf(state, 'V')).toBeCloseTo(10.05, 9)
    const a0 = state.project.audio.findIndex((c) => c.id === 'A0')
    expect(clipStart(state.project.audio, a0)).toBeCloseTo(10.05, 9)
  })
})
