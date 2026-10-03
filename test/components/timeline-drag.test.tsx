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
