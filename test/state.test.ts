/**
 * The store actually builds and the slices are actually wired.
 *
 * This exists because the store is a composition root: the slices are constructed
 * in a load-bearing order, and two of them hold a reference to each other
 * (`edits` needs the playhead, `transport` needs `edits.setTransform`). A
 * type checker cannot see a use-before-assign inside a closure — `let
 * transport; const edits = createEdits({ playhead: () => transport.playhead() })`
 * type-checks perfectly and throws the moment it is called.
 *
 * So this builds the real thing, with only the browser globals shimmed, and
 * drives the paths that cross slice boundaries. If a slice is constructed in
 * the wrong order, or a dependency is wired to the wrong slice, it fails here.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { clipStart } from '../src/model/project.ts'

// --- the minimum browser surface the store touches at construction ---------
const noop = (): void => undefined
const g = globalThis as Record<string, unknown>
g.window ??= { addEventListener: noop, removeEventListener: noop }
g.indexedDB ??= {
  open: () => ({ onsuccess: noop, onerror: noop, onupgradeneeded: noop, result: {} }),
}
g.IDBKeyRange ??= { bound: () => noop }
g.performance ??= { now: () => 0 }
g.AudioContext ??= class {
  state = 'suspended'
  currentTime = 0
  sampleRate = 48000
  destination = {}
  createGain = () => ({ gain: { value: 1 }, connect: noop })
  createBufferSource = () => ({ connect: noop, start: noop, stop: noop, buffer: null })
  createBuffer = () => ({ getChannelData: () => new Float32Array(48000) })
  decodeAudioData = async () => ({})
  resume = async () => undefined
  close = async () => undefined
}

const { createAppState } = await import('../src/app/store/state.ts')

test('the store builds', () => {
  const state = createAppState()
  assert.ok(state.project, 'a project exists')
  assert.equal(state.project.version, 2)
  assert.equal(state.duration(), 0, 'an empty timeline is zero seconds long')
})

test('every slice is reachable from the composed surface', () => {
  const state = createAppState()
  // A representative member of each slice, so removing one from the public
  // surface — or wiring a slice to the wrong dependencies — fails here.
  for (const [name, value] of Object.entries({
    selection: state.selectionCount,
    selectionRead: state.selection,
    history: state.canUndo,
    assets: state.assetIds,
    assetsAdd: state.addFiles,
    edits: state.splitAt,
    editsDuplicate: state.duplicateSelected,
    transport: state.seek,
    transportPlay: state.togglePlay,
    geometry: state.clipRect,
  })) {
    assert.equal(typeof value, 'function', `${name} should be exposed and callable`)
  }
  assert.ok(state.transport, 'the transport slice is reachable as a whole')
  assert.ok(state.history, 'the history slice is reachable as a whole')
})

test('an unknown selection resolves to nothing rather than throwing', () => {
  const state = createAppState()
  state.selectClip('does-not-exist')
  assert.equal(state.selectionCount(), 1)
  assert.deepEqual(state.selectedClips(), [], 'and contributes no clips')
  // These are the cross-slice reads that would blow up on a bad id.
  assert.equal(state.selectedClip(), null)
  assert.equal(state.selectedIsLinked(), false)
  assert.equal(state.selectedPartner(), null)
  assert.equal(state.findClipById('does-not-exist'), null)
  assert.deepEqual(state.selectedLanes(), [])
})

test('every action is safe to call against an empty timeline', () => {
  // An empty project is the state the app boots into, so every action has to
  // survive it. These are the ones a user can reach before importing anything.
  const state = createAppState()
  const noThrow = (name: string, fn: () => unknown): void => {
    try {
      fn()
    } catch (err) {
      assert.fail(`${name} threw on an empty timeline: ${String(err)}`)
    }
  }
  noThrow('deleteSelected', () => state.deleteSelected())
  noThrow('duplicateSelected', () => state.duplicateSelected())
  noThrow('splitSelectionAtPlayhead', () => state.splitSelectionAtPlayhead())
  noThrow('trimSelectionToPlayhead', () => state.trimSelectionToPlayhead())
  noThrow('breakSelectedLinks', () => state.breakSelectedLinks())
  noThrow('toggleMuteSelected', () => state.toggleMuteSelected())
  noThrow('clearLane', () => state.clearLane('video'))
  noThrow('clearLane audio', () => state.clearLane('audio'))
  noThrow('splitAt', () => state.splitAt(0))
  noThrow('undo', () => state.undo())
  noThrow('redo', () => state.redo())
  noThrow('selectAll', () => state.selectAll())
  noThrow('removeAsset', () => state.removeAsset('nope'))
  noThrow('addAssetToTimeline', () => state.addAssetToTimeline('nope'))
  noThrow('addAssetAt', () => state.addAssetAt('nope', 'video', 0))
  noThrow('setTransformActive', () => state.setTransformActive({ scale: 1, x: 0, y: 0 }))
  noThrow('resetView', () => state.resetView())
})

test('an empty timeline cannot be seeked past its end', () => {
  // duration() is 0, so every seek clamps to 0. Worth pinning, because a seek
  // that ignored the clamp would put the playhead where nothing exists.
  const state = createAppState()
  state.seek(5)
  assert.equal(state.playhead(), 0)
  state.seek(-10)
  assert.equal(state.playhead(), 0)
})

test('transport reads the playhead it was given', () => {
  // `edits` receives `playhead: () => transport.playhead()`. If that closure
  // were pointed at the wrong signal, trim-to-playhead would act on the wrong
  // time and nothing else would notice.
  const state = createAppState()
  state.project.video.push({ id: 'a', lane: 'video', assetId: 'a', in: 0, out: 10 })
  assert.equal(state.duration(), 10, 'the lane is 10 seconds long')

  state.seek(5)
  assert.equal(state.playhead(), 5)
  state.step(1) // one frame at 30fps
  assert.ok(state.playhead() > 5 && state.playhead() < 5.1, `stepped one frame, got ${state.playhead()}`)
  state.step(-1)
  assert.ok(Math.abs(state.playhead() - 5) < 1e-9, 'and back again')

  state.seek(-10)
  assert.equal(state.playhead(), 0, 'clamped at the start')
  state.seek(1e9)
  assert.equal(state.playhead(), 10, 'and at the end')
})

test('zoom scales pixels but not time', () => {
  const state = createAppState()
  state.setZoom(80)
  const x = state.timeToX(10)
  assert.equal(state.xToTime(x), 10, 'the round trip at 80px/s')

  state.setZoom(160)
  assert.equal(state.timeToX(10), x * 2, 'the same instant is twice as many pixels')
  assert.equal(state.xToTime(state.timeToX(10)), 10, 'and time is unchanged by zoom')
})

test('removing an asset removes it from the project, not just its clips', () => {
  // The bin lists `project.assets`, so filtering the clips and dropping the
  // decoder is not enough: the map entry has to go too, or the row lingers and
  // the asset is written back on the next autosave.
  const state = createAppState()
  state.project.assets['ast_1'] = {
    id: 'ast_1', name: 'a.mp4', duration: 5, width: 1920, height: 1080, rotation: 0,
    frameRate: 30, variableFrameRate: false, hasVideo: true, hasAudio: true,
    audioSampleRate: 48000, audioChannels: 2, videoCodec: 'avc', audioCodec: 'aac', size: 10,
  }
  state.project.video.push({ id: 'c1', lane: 'video', assetId: 'ast_1', in: 0, out: 5 })

  assert.deepEqual(state.assetIds(), ['ast_1'])
  state.removeAsset('ast_1')

  assert.deepEqual(state.assetIds(), [], 'the asset is gone from the bin')
  assert.equal(state.project.assets['ast_1'], undefined, 'and from the project map')
  assert.equal(state.project.video.length, 0, 'and its clips with it')
})

test('moving a multi-selection shifts every selected clip', () => {
  // The store reads the live selection and hands it to the model, so this is
  // the wiring between "I have several clips selected" and the rigid shift.
  const state = createAppState()
  state.project.video.push({ id: 'a', lane: 'video', assetId: 'x', in: 0, out: 5 })
  state.project.video.push({ id: 'b', lane: 'video', assetId: 'x', in: 0, out: 5 })

  state.selectClip('a')
  state.selectClip('b', 'toggle')
  state.moveSelection('video', 0, 7)

  assert.deepEqual(
    state.project.video.map((_, i) => clipStart(state.project.video, i)),
    [7, 12],
    'the whole selection moved together',
  )
})

test('the three snap toggles are independent', () => {
  const state = createAppState()
  assert.equal(state.clipSnap(), true, 'clip snap starts on')
  assert.equal(state.laneSnap(), true, 'lane snap starts on')
  assert.equal(state.playheadSnap(), true, 'playhead snap starts on')

  // Clip/lane off leaves the playhead mode alone.
  state.setClipSnap(false)
  state.setLaneSnap(false)
  assert.equal(state.snapping(), false, 'the clip/lane gate is off')
  assert.equal(state.playheadSnap(), true, 'and playhead snapping is untouched')

  // Turning the playhead off, then clip back on, must not turn the playhead on.
  state.setPlayheadSnap(false)
  state.setClipSnap(true)
  assert.equal(state.snapping(), true, 'clip snapping is back')
  assert.equal(state.playheadSnap(), false, 'but playhead snapping stayed off')
})

test('notices appear and are announced through the shared notify', () => {
  const state = createAppState()
  assert.equal(state.notices().length, 0)
  state.notify('info', 'hello')
  assert.equal(state.notices().length, 1)
  assert.equal(state.notices().at(-1)?.text, 'hello')
  state.notify('error', 'bad')
  assert.equal(state.notices().at(-1)?.kind, 'error')
})
