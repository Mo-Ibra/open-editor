/**
 * Splitting a clip must draw two *touching* pieces.
 *
 * Every other split test asserts the model, and the model was never wrong here.
 * The failure this pins was in the render path: a clip's start came from a
 * memoised bulk pass, and the first version of that pass cached a `createMemo`
 * lazily inside the store. When the computation that read it re-ran, Solid
 * disposed the child memo it owned, and the cached reference returned its stale
 * value forever — so the right half was drawn at the position the *old* layout
 * had for that index, leaving a visible gap.
 *
 * The assertion is deliberately on the rendered `left`/`width`, because that is
 * the layer the model tests cannot see.
 */

import { describe, expect, it } from 'vitest'
import { render } from '@solidjs/testing-library'

const noop = (): undefined => undefined
const g = globalThis as Record<string, unknown>
g.window ??= { addEventListener: noop, removeEventListener: noop }
g.indexedDB ??= { open: () => ({ onsuccess: noop, onerror: noop, onupgradeneeded: noop, result: {} }) }
g.IDBKeyRange ??= { bound: () => noop }
g.crypto ??= { randomUUID: () => 'x' }

const { createAppState } = await import('../../src/app/store/state.js')
const { Lane } = await import('../../src/app/view/timeline/Lane.js')

const asset = {
  id: 'a', name: 'a.mp4', duration: 20, width: 1920, height: 1080, rotation: 0,
  frameRate: 30, variableFrameRate: false, hasVideo: true, hasAudio: true,
  audioSampleRate: 48000, audioChannels: 2, videoCodec: 'avc', audioCodec: 'aac', size: 1,
}

async function seed(state: ReturnType<typeof createAppState>, project: unknown): Promise<void> {
  const file = { format: 'open-editor.project', formatVersion: 1, name: 't', savedAt: 0, project, media: {} }
  try {
    await state.projects.importText(JSON.stringify(file))
  } catch {
    // importText writes the project before its storage tail; a stub IndexedDB
    // can reject the tail. The timeline is already in place, which is the point.
  }
}

const boxes = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-clip-index]')].map((el) => {
    const s = (el as HTMLElement).style
    return { left: s.left, width: s.width }
  })

const lane = (state: ReturnType<typeof createAppState>) => (
  <Lane trackId="video" type="video" label="v" state={state} height={80} dropAt={() => null} setDropAt={() => {}} trackLeft={() => 0} />
)

describe('Lane handles a split', () => {
  it('draws the two halves flush, for a linked pair', async () => {
    const state = createAppState()
    await seed(state, {
      version: 3,
      assets: { a: asset },
      tracks: [
        { id: 'video', type: 'video', clips: [{ id: 'v1', trackId: 'video', assetId: 'a', in: 0, out: 20, linkId: 'L' }] },
        { id: 'audio', type: 'audio', clips: [{ id: 'a1', trackId: 'audio', assetId: 'a', in: 0, out: 20, linkId: 'L' }] },
      ],
    })
    state.setZoom(80)

    const { container } = render(() => lane(state))
    state.seek(5)
    state.selectAll() // both halves selected → the pair is cut together
    state.splitAt(state.playhead())

    // 5s * 80px/s = 400px, then 15s * 80 = 1200px.
    expect(boxes(container)).toEqual([
      { left: '0px', width: '400px' },
      { left: '400px', width: '1200px' },
    ])
    // And the sound follows, which was the other half of the cutting bug.
    expect(state.project.tracks.find((t) => t.type === 'audio')!.clips.length).toBe(2)
  })

  it('still tracks positions after the lane remounts', async () => {
    // A lane can unmount and remount — a panel toggle, a layout change, HMR.
    // The store's position pass must survive that. The first version cached a
    // `createMemo` at store scope, so the remount disposed the memo the store
    // was still holding, and every later split drew its right half at the old
    // layout's position: a fixed gap.
    const state = createAppState()
    await seed(state, {
      version: 3,
      assets: { a: asset },
      tracks: [
        { id: 'video', type: 'video', clips: [{ id: 'v1', trackId: 'video', assetId: 'a', in: 0, out: 20 }] },
        { id: 'audio', type: 'audio', clips: [] },
      ],
    })
    state.setZoom(80)

    const first = render(() => lane(state))
    first.unmount()

    // Remount with the same store, then split.
    const second = render(() => lane(state))
    state.seek(5)
    state.selectClip('v1')
    state.splitAt(state.playhead())

    expect(boxes(second.container)).toEqual([
      { left: '0px', width: '400px' },
      { left: '400px', width: '1200px' },
    ])
  })

  it('keeps the leading gap where it was, and adds none', async () => {
    const state = createAppState()
    await seed(state, {
      version: 3,
      assets: { a: asset },
      tracks: [
        // 5s of deliberate silence, then a 20s clip.
        { id: 'video', type: 'video', clips: [{ id: 'v1', trackId: 'video', assetId: 'a', in: 0, out: 20, offset: 5 }] },
        { id: 'audio', type: 'audio', clips: [] },
      ],
    })
    state.setZoom(80)

    const { container } = render(() => lane(state))
    state.seek(15) // 10s into the clip
    state.selectClip('v1')
    state.splitAt(state.playhead())

    // The gap is 5s (400px); each half is 10s (800px), touching at 15s (1200px).
    expect(boxes(container)).toEqual([
      { left: '400px', width: '800px' },
      { left: '1200px', width: '800px' },
    ])
  })
})
