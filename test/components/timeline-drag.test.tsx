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
      version: 3,
      assets: { a: asset },
      tracks: [
        { id: 'video', type: 'video', clips: [
          { id: 'A', trackId: 'video', assetId: 'a', in: 0, out: 10 },
          { id: 'B', trackId: 'video', assetId: 'a', in: 0, out: 10 },
        ] },
        { id: 'audio', type: 'audio', clips: [] },
      ],
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
        trackId="video"
        type="video"
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

const videoOf = (state: State) => state.project.tracks.find((t) => t.type === 'video')!.clips
const audioOf = (state: State) => state.project.tracks.find((t) => t.type === 'audio')!.clips

const startOf = (state: State, id: string): number => {
  const clips = videoOf(state)
  return clipStart(clips, clips.findIndex((c) => c.id === id))
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
    expect(videoOf(state).map((c) => c.id)).toEqual(['A', 'B'])
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

  it('deleting the first clip after a leading gap leaves the survivor in place', async () => {
    const state = createAppState()
    await seed(state) // A 0–10, B 10–20
    state.setZoom(80)
    state.setClipSnap(false)
    state.setLaneSnap(false)

    const { container } = render(() => <Harness state={state} />)
    const track = container.firstElementChild as HTMLElement
    const a = container.querySelector('[data-clip-id="A"]') as HTMLElement
    const b = container.querySelector('[data-clip-id="B"]') as HTMLElement

    // Pull B to 25s: `-----A-----B` (a gap between the two).
    fireEvent.pointerDown(b, { clientX: 800, pointerId: 1 })
    fireEvent.pointerMove(track, { clientX: 2000, pointerId: 1 })
    fireEvent.pointerUp(track, { pointerId: 1 })
    expect(startOf(state, 'A')).toBe(0)
    expect(startOf(state, 'B')).toBe(25)

    // Slide the pair right by 5s: `-----A----------B`.
    state.selectClip('A')
    state.selectClip('B', 'toggle')
    fireEvent.pointerDown(a, { clientX: 0, pointerId: 1 })
    fireEvent.pointerMove(track, { clientX: 400, pointerId: 1 })
    fireEvent.pointerUp(track, { pointerId: 1 })
    expect(startOf(state, 'A')).toBe(5)
    const bBefore = startOf(state, 'B')
    expect(bBefore).toBe(30)

    // Delete the first clip. B must not move.
    state.clearSelection()
    state.selectClip('A')
    state.deleteSelected()
    expect(videoOf(state).map((c) => c.id)).toEqual(['B'])
    expect(startOf(state, 'B')).toBe(bBefore)
  })

  it('deleting a middle clip does not drag a clip that sits behind a gap', async () => {
    const state = createAppState()
    const file = {
      format: 'open-editor.project',
      formatVersion: 1,
      name: 't',
      savedAt: 0,
      project: {
        version: 3,
        assets: { a: asset },
        tracks: [
          { id: 'video', type: 'video', clips: [
            { id: 'A', trackId: 'video', assetId: 'a', in: 0, out: 10 },
            { id: 'B', trackId: 'video', assetId: 'a', in: 0, out: 10 },
            { id: 'C', trackId: 'video', assetId: 'a', in: 0, out: 10, offset: 5 },
          ] },
          { id: 'audio', type: 'audio', clips: [] },
        ],
      },
      media: {},
    }
    try {
      await state.projects.importText(JSON.stringify(file))
    } catch {
      // The project is written before importText's storage tail.
    }
    state.setZoom(80)
    state.setClipSnap(false)
    state.setLaneSnap(false)

    render(() => <Harness state={state} />)
    expect(startOf(state, 'A')).toBe(0)
    expect(startOf(state, 'B')).toBe(10)
    expect(startOf(state, 'C')).toBe(25) // C has a gap before it

    state.clearSelection()
    state.selectClip('B')
    state.deleteSelected()

    expect(videoOf(state).map((c) => c.id)).toEqual(['A', 'C'])
    expect(startOf(state, 'A')).toBe(0)
    expect(startOf(state, 'C')).toBe(25) // the gap absorbed B's hole
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

    expect(videoOf(state)[1]!.out).toBeCloseTo(7, 9)
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

    expect(videoOf(state)[1]!.in).toBeCloseTo(2, 9)
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
        version: 3,
        assets: { a: { ...asset, hasAudio: true } },
        // A linked pair, plus an unselected audio clip whose start is the bait.
        tracks: [
          { id: 'video', type: 'video', clips: [{ id: 'V', trackId: 'video', assetId: 'a', in: 0, out: 10, linkId: 'L' }] },
          { id: 'audio', type: 'audio', clips: [
            { id: 'A0', trackId: 'audio', assetId: 'a', in: 0, out: 10, linkId: 'L' },
            { id: 'A1', trackId: 'audio', assetId: 'a', in: 0, out: 10, offset: 10 }, // timeline 20..30
          ] },
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
    const audio = audioOf(state)
    const a0 = audio.findIndex((c) => c.id === 'A0')
    expect(clipStart(audio, a0)).toBeCloseTo(10.05, 9)
  })
})

describe('dragging a clip to another track', () => {
  async function seedTwoVideo(state: State): Promise<void> {
    const file = {
      format: 'open-editor.project',
      formatVersion: 1,
      name: 't',
      savedAt: 0,
      project: {
        version: 3,
        assets: { a: asset },
        tracks: [
          { id: 'v2', type: 'video', clips: [] },
          { id: 'video', type: 'video', clips: [
            { id: 'A', trackId: 'video', assetId: 'a', in: 0, out: 10 },
            { id: 'B', trackId: 'video', assetId: 'a', in: 0, out: 10 },
          ] },
        ],
      },
      media: {},
    }
    try {
      await state.projects.importText(JSON.stringify(file))
    } catch {
      // The project is written before importText's storage tail.
    }
  }

  function TwoTrackHarness(props: { state: State }) {
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
        <Lane trackId="v2" type="video" label="v2" state={props.state} height={80} dropAt={() => null} setDropAt={() => {}} trackLeft={() => 0} />
        <Lane trackId="video" type="video" label="video" state={props.state} height={80} dropAt={() => null} setDropAt={() => {}} trackLeft={() => 0} />
      </div>
    )
  }

  it('moves a clip straight down onto the video track under the pointer', async () => {
    const state = createAppState()
    await seedTwoVideo(state)
    state.setZoom(80)
    state.setClipSnap(false)
    state.setLaneSnap(false)

    const { container } = render(() => <TwoTrackHarness state={state} />)
    const root = container.firstElementChild as HTMLElement
    const v2El = container.querySelector('[data-track="v2"]') as HTMLElement
    const v1El = container.querySelector('[data-track="video"]') as HTMLElement
    const rect = (top: number): DOMRect =>
      ({ top, height: 80, bottom: top + 80, left: 0, right: 800, width: 800, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
    // jsdom gives every element a zero rect; the hit test needs real rows.
    Object.defineProperty(v2El, 'getBoundingClientRect', { value: () => rect(0) })
    Object.defineProperty(v1El, 'getBoundingClientRect', { value: () => rect(80) })

    const clipB = container.querySelector('[data-clip-id="B"]') as HTMLElement
    // Press B (timeline 10) and drag straight up, no horizontal travel at all.
    fireEvent.pointerDown(clipB, { clientX: 1000, clientY: 120, pointerId: 1 })
    fireEvent.pointerMove(root, { clientX: 1000, clientY: 40, pointerId: 1 })
    fireEvent.pointerUp(root, { pointerId: 1 })

    const v2 = state.project.tracks.find((t) => t.id === 'v2')!
    const v1 = state.project.tracks.find((t) => t.id === 'video')!
    expect(v2.clips.map((c) => c.id)).toEqual(['B'])
    expect(clipStart(v2.clips, 0)).toBe(10)
    expect(v1.clips.map((c) => c.id)).toEqual(['A'])
  })
})

describe('the remove-track button', () => {
  it('keeps the track drag handler out of its pointerdown, so the click fires', () => {
    // The button lives inside `#timeline-track`, whose pointerdown captures the
    // pointer for dragging. The capture retargeted the click away from the
    // button, so removal never fired. Stopping propagation on the button's
    // pointerdown is the fix; this asserts the track handler is never reached.
    const state = createAppState()
    let trackDown = 0
    let removed = 0
    const { container } = render(() => (
      <div onPointerDown={() => { trackDown++ }}>
        <Lane
          trackId="video"
          type="video"
          label="video"
          state={state}
          height={80}
          dropAt={() => null}
          setDropAt={() => {}}
          trackLeft={() => 0}
          canRemove={true}
          onRemove={() => { removed++ }}
        />
      </div>
    ))
    const button = container.querySelector('[aria-label="Remove video track"]') as HTMLElement
    expect(button).toBeTruthy()

    fireEvent.pointerDown(button, { pointerId: 1 })
    expect(trackDown, 'the button press must not start a track drag').toBe(0)

    fireEvent.click(button)
    expect(removed, 'the click reaches the button and removes the track').toBe(1)
  })
})
