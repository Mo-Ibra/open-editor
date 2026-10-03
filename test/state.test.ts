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
  state = 'running'
  currentTime = 0
  sampleRate = 48000
  destination = {}
  createGain = () => ({ gain: { value: 1, setTargetAtTime: noop }, connect: noop, disconnect: noop })
  createBufferSource = () => ({ connect: noop, disconnect: noop, start: noop, stop: noop, buffer: null })
  createBuffer = () => ({ getChannelData: () => new Float32Array(48000) })
  decodeAudioData = async () => ({})
  resume = async () => undefined
  close = async () => undefined
}
// `AudioEngine` reaches for `window.AudioContext` first and only falls back to
// the bare global, so the stub above is invisible to it unless it is reachable
// from `window` too. Without this the transport cannot start audio at all, and
// every assertion about playback is untestable rather than untrue.
;(g.window as { AudioContext?: unknown }).AudioContext ??= g.AudioContext

const { createAppState } = await import('../src/app/store/state.ts')
const { frameRateFor } = await import('../src/app/store/transport.ts')

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
    geometry: state.clipStartsFor,
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

test('stopping playback stops the audio, not just the flag', async () => {
  // The flag and the sound are two different pieces of state, and `setPlaying`
  // used to be the bare signal setter. So the two callers outside `togglePlay` —
  // a click on the timeline, and the end-of-timeline check in the playback clock
  // — cleared the flag and left the AudioContext running: the picture froze and
  // the sound did not.
  const state = createAppState()
  state.project.video.push({ id: 'v1', lane: 'video', assetId: 'a', in: 0, out: 10 })
  state.project.audio.push({ id: 'a1', lane: 'audio', assetId: 'a', in: 0, out: 10 })

  await state.togglePlay()
  assert.equal(state.playing(), true)
  assert.equal(state.audio.running, true, 'the engine is what makes the sound')

  // Exactly what use-timeline-drag's pointerdown does.
  state.setPlaying(false)
  assert.equal(state.playing(), false)
  assert.equal(state.audio.running, false, 'and it stopped with the flag')

  // Idempotent, because both callers stop unconditionally and `stop()` on an
  // idle engine has to stay harmless.
  state.setPlaying(false)
  assert.equal(state.audio.running, false)
})

test('a seek in flight cannot resurrect a stopped transport', async () => {
  // `seek` while playing is `void restartAt(...)` — fire and forget — so the
  // engine is started from an unawaited async call. The `await` inside it is a
  // window in which the user can click the timeline, and without a guard the run
  // that was just cancelled lands afterwards and plays on a stopped transport.
  const state = createAppState()
  state.project.video.push({ id: 'v1', lane: 'video', assetId: 'a', in: 0, out: 10 })
  state.project.audio.push({ id: 'a1', lane: 'audio', assetId: 'a', in: 0, out: 10 })
  await state.togglePlay()

  state.seek(5)
  state.setPlaying(false)
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(state.playing(), false)
  assert.equal(state.audio.running, false, 'the cancelled run did not start')
})

test('the playhead cannot outlive the timeline', () => {
  // A delete shrinks the lanes under a stationary playhead. `seek` and
  // `advanceClock` both clamp, but neither runs when the *lanes* change, so
  // nothing moved it back: the playhead sat at 20s on a timeline of nothing,
  // drawn far outside the track's width and so unreachable by dragging.
  const state = createAppState()
  state.project.video.push({ id: 'v1', lane: 'video', assetId: 'a', in: 0, out: 30 })
  state.selectClip('v1')
  state.seek(20)
  assert.equal(state.playhead(), 20)

  state.deleteSelected()
  assert.equal(state.duration(), 0, 'the timeline is empty')
  assert.equal(state.playhead(), 0, 'so the playhead was pulled back inside it')
})

test('the playhead is pulled back when a lane is cleared', () => {
  // The other way the timeline shortens. The timeline is as long as its longest
  // lane, so clearing the audio lane is what pulls the end in under the playhead.
  const state = createAppState()
  state.project.video.push({ id: 'v1', lane: 'video', assetId: 'a', in: 0, out: 10 })
  state.project.audio.push({ id: 'a1', lane: 'audio', assetId: 'a', in: 0, out: 40 })
  state.seek(35)
  assert.equal(state.playhead(), 35, 'past the end of the video lane, inside the timeline')

  state.clearLane('audio')
  assert.equal(state.duration(), 10, 'only the video lane is left')
  assert.equal(state.playhead(), 10, 'so the playhead came back to the new end')
})

test('a project write that does not shorten the timeline leaves the playhead alone', () => {
  // The clamp must only write when it is actually out of range. `setProject`
  // runs after every edit, and writing an unchanged playhead would dirty every
  // reader of it — including the preview's redraw effect — on every drag frame.
  const state = createAppState()
  state.project.video.push({ id: 'v1', lane: 'video', assetId: 'a', in: 0, out: 30 })
  state.selectClip('v1')
  state.seek(20)

  state.reorder('video', 0, 0) // a no-op edit, but it still goes through setProject
  assert.equal(state.playhead(), 20, 'untouched')
})

test('a split that split nothing costs nothing', () => {
  // `splitAt` used to commit *before* it knew there was anything to cut, so `S`
  // over empty space pushed an undo entry that undid nothing. The user paid twice:
  // once for the phantom entry, and again when the undo they pressed to be safe
  // ate their previous real edit.
  const state = createAppState()
  state.project.video.push({ id: 'v1', lane: 'video', assetId: 'a', in: 0, out: 10 })
  state.selectClip('v1')
  assert.equal(state.canUndo(), false, 'a fresh timeline has no history')

  state.seek(50) // well past the end of the clip
  state.splitAt(state.playhead())
  assert.equal(state.project.video.length, 1, 'nothing was split')
  assert.equal(state.canUndo(), false, 'and nothing was recorded')

  state.seek(5) // inside the clip
  state.splitAt(state.playhead())
  assert.equal(state.project.video.length, 2, 'a real split still happens')
  assert.equal(state.canUndo(), true, 'and is recorded')

  state.undo()
  assert.equal(state.project.video.length, 1, 'undo took it straight back')
})

test('a split refused as too close to an edge costs nothing either', () => {
  // The playhead is inside the clip, but 20ms from its start — inside this
  // function's own MIN_SPLIT guard of 10ms and outside the model's MIN_CLIP of
  // 40ms, so `splitLinked` refuses it. Counting that as a split is what put a
  // history entry in the stack for an edit that did not happen.
  const state = createAppState()
  state.project.video.push({ id: 'v1', lane: 'video', assetId: 'a', in: 0, out: 10 })
  state.selectClip('v1')

  state.seek(0.02)
  state.splitSelectionAtPlayhead()
  assert.equal(state.project.video.length, 1, 'not split')
  assert.equal(state.canUndo(), false, 'and not recorded')
  assert.match(state.notices().at(-1)?.text ?? '', /Nothing to split/, 'and it says so')

  // Comfortably inside: split, record, report.
  state.seek(5)
  state.splitSelectionAtPlayhead()
  assert.equal(state.project.video.length, 2)
  assert.equal(state.canUndo(), true)
  assert.match(state.notices().at(-1)?.text ?? '', /Split 1 clip\./)
})

test('cutting a linked pair keeps each half paired to its own sound', () => {
  // The original cutting bug, with both halves selected (which is now how "cut
  // the pair" is expressed). The right halves must share a fresh link so a
  // *second* cut still reaches the right audio.
  const state = createAppState()
  state.project.video.push({ id: 'v1', lane: 'video', assetId: 'a', in: 0, out: 20, linkId: 'L' })
  state.project.audio.push({ id: 'a1', lane: 'audio', assetId: 'a', in: 0, out: 20, linkId: 'L' })

  state.selectAll()
  state.seek(5)
  state.splitAt(state.playhead())
  assert.equal(state.project.video.length, 2, 'picture split')
  assert.equal(state.project.audio.length, 2, 'sound split with it')

  state.selectAll()
  state.seek(10)
  state.splitAt(state.playhead())
  assert.equal(state.project.video.length, 3, 'second picture cut')
  assert.equal(state.project.audio.length, 3, 'and the sound followed')
})

test('split cuts only the selected lane', () => {
  // The selection names the lanes to cut. Selecting the picture leaves the
  // sound whole; selecting the sound leaves the picture whole.
  const state = createAppState()
  state.project.video.push({ id: 'v1', lane: 'video', assetId: 'a', in: 0, out: 20, linkId: 'L' })
  state.project.audio.push({ id: 'a1', lane: 'audio', assetId: 'a', in: 0, out: 20, linkId: 'L' })

  state.selectClip('v1')
  state.seek(5)
  state.splitAt(state.playhead())
  assert.equal(state.project.video.length, 2, 'the picture split')
  assert.equal(state.project.audio.length, 1, 'and the sound did not')

  state.selectClip('a1')
  state.seek(15)
  state.splitAt(state.playhead())
  assert.equal(state.project.audio.length, 2, 'now the sound split')
  assert.equal(state.project.video.length, 2, 'and the picture count did not change')
})

test('split with nothing selected cuts both lanes', () => {
  const state = createAppState()
  state.project.video.push({ id: 'v1', lane: 'video', assetId: 'a', in: 0, out: 20, linkId: 'L' })
  state.project.audio.push({ id: 'a1', lane: 'audio', assetId: 'a', in: 0, out: 20, linkId: 'L' })

  state.clearSelection()
  state.seek(5)
  state.splitAt(state.playhead())
  assert.equal(state.project.video.length, 2)
  assert.equal(state.project.audio.length, 2)
})

test('split cuts the clip under the playhead in the selected lane', () => {
  // "Sometimes S does nothing" was because the cut was tied to the *selected
  // clip*, not the lane: a playhead parked over a different clip in the same
  // lane found nothing to cut. The selection now picks the lane; the playhead
  // picks the clip.
  const state = createAppState()
  state.project.video.push({ id: 'a', lane: 'video', assetId: 'a', in: 0, out: 10 })
  state.project.video.push({ id: 'b', lane: 'video', assetId: 'a', in: 0, out: 10 })

  state.selectClip('a') // the *left* clip is selected...
  state.seek(15) // ...but the playhead is over the right one
  state.splitAt(state.playhead())

  assert.equal(state.project.video.length, 3, 'the clip under the playhead split')
  assert.equal(state.project.video[0]!.id, 'a', 'and the selected-but-not-under-playhead clip is untouched')
  assert.equal(state.project.video[0]!.out, 10)
})

test('trim selection trims both halves of a selected pair', () => {
  // Bug #8: trim copied split's link dedupe, so the audio half was dropped and
  // "trim to playhead" silently trimmed only the picture.
  const state = createAppState()
  state.project.video.push({ id: 'v1', lane: 'video', assetId: 'a', in: 0, out: 20, linkId: 'L' })
  state.project.audio.push({ id: 'a1', lane: 'audio', assetId: 'a', in: 0, out: 20, linkId: 'L' })

  // Cut both lanes (nothing selected), so there are four clips to trim.
  state.clearSelection()
  state.seek(5)
  state.splitAt(state.playhead())
  assert.equal(state.project.audio.length, 2)

  // Playhead at 18, nearer the end of each right half (which spans 5..20), so
  // each is trimmed at its end.
  state.selectAll()
  state.seek(18)
  state.trimSelectionToPlayhead()

  assert.equal(state.project.video[1]!.out, 18, 'the picture was trimmed to the playhead')
  assert.equal(state.project.audio[1]!.out, 18, 'and so was the sound')
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

test('a drop honours the snap toggles, in the lane it is aimed at', () => {
  // The bug: `dropTimeFor` collected targets from *both* lanes unconditionally
  // and asked only "is either toggle on?", so with clip snap switched off in the
  // toolbar a dropped file still snapped to same-lane clip edges. The toggle was a
  // lie for drops.
  const state = createAppState()
  state.project.assets.a = {
    id: 'a', name: 'a.mp4', duration: 10, width: 1920, height: 1080, rotation: 0,
    frameRate: 30, variableFrameRate: false, hasVideo: true, hasAudio: true,
    audioSampleRate: 48000, audioChannels: 2, videoCodec: 'avc', audioCodec: 'aac', size: 10,
  }
  state.project.video.push({ id: 'v1', lane: 'video', assetId: 'a', in: 0, out: 10 })
  state.setZoom(80)
  state.seek(0)

  // 10px at 80px/s is 0.125s, and the drop radius is 14px = 0.175s. So 9.95 is
  // comfortably inside the pull towards the clip's end at 10s.
  const near = 9.95
  assert.equal(state.dropTimeFor(near, 'video'), 10, 'with clip snap on, it snaps to the same-lane edge')

  state.setClipSnap(false)
  state.setLaneSnap(true)
  assert.equal(
    state.dropTimeFor(near, 'video'),
    near,
    'with clip snap OFF, a same-lane edge is not a target, even though lane snap is on',
  )
  assert.equal(
    state.dropTimeFor(near, 'audio'),
    10,
    'and on the audio lane, lane snap means the video lane — which is still eligible',
  )

  state.setLaneSnap(false)
  assert.equal(state.dropTimeFor(near, 'video'), near, 'both off means no snapping at all')

  // And with both on it is symmetric, which is what "this row" is supposed to mean.
  state.setClipSnap(true)
  state.setLaneSnap(true)
  assert.equal(state.dropTimeFor(near, 'video'), 10)
  assert.equal(state.dropTimeFor(near, 'audio'), 10)
})

test('the frame rate playback steps by is the source\'s, not the output\'s', () => {
  // `OUTPUT_FPS` is fixed at 30 for the muxer, which is true and irrelevant to
  // stepping a playhead. On a 24fps source the arrow keys moved 0.8 of a frame, so
  // repeated stepping walked off frame boundaries.
  const at24 = { frameRate: 24, variableFrameRate: false } as never
  const at30 = { frameRate: 30, variableFrameRate: false } as never
  const vfr = { frameRate: 4, variableFrameRate: true } as never

  assert.equal(frameRateFor(at24), 24, 'a 24fps source steps 24')
  assert.equal(frameRateFor(at30), 30)
  // A VFR asset has no meaningful average — 3.75fps for a screen recording — and
  // `settingsFor` already declines to export at one. So does this.
  assert.equal(frameRateFor(vfr), 30, 'a VFR source falls back to the output rate')
  assert.equal(frameRateFor(undefined), 30, 'and so does nothing at all')
  assert.equal(frameRateFor({ frameRate: 0, variableFrameRate: false } as never), 30, 'and nonsense')
})

test('the arrow keys step whole source frames', () => {
  const state = createAppState()
  const asset = (fps: number, vfr = false) => ({
    id: 'a', name: 'a.mp4', duration: 30, width: 1920, height: 1080, rotation: 0 as const,
    frameRate: fps, variableFrameRate: vfr, hasVideo: true, hasAudio: false,
    audioSampleRate: 48000, audioChannels: 0, videoCodec: 'avc', audioCodec: null, size: 10,
  })

  state.project.assets.a = asset(24)
  state.project.video.push({ id: 'v1', lane: 'video', assetId: 'a', in: 0, out: 30 })
  state.seek(5)
  state.step(1)
  assert.ok(Math.abs(state.playhead() - (5 + 1 / 24)) < 1e-9, `one 24fps frame, got ${state.playhead()}`)

  // Ten frames of 24fps must land exactly back on a frame boundary of 30fps
  // arithmetic — i.e. the error does not compound.
  state.seek(5)
  for (let i = 0; i < 10; i++) state.step(1)
  assert.ok(Math.abs(state.playhead() - (5 + 10 / 24)) < 1e-9, 'and ten of them add up')

  // A VFR source still steps, at the fallback rate rather than at 3.75fps.
  state.project.assets.a = asset(4, true)
  state.seek(5)
  state.step(1)
  assert.ok(Math.abs(state.playhead() - (5 + 1 / 30)) < 1e-9, 'a VFR source steps at the output rate')

  // Nothing under the playhead and nothing selected: still steps, no throw.
  state.seek(0)
  state.project.video.length = 0
  state.selectClip('nope')
  state.step(-1)
  assert.equal(state.playhead(), 0, 'clamped at the start, and no throw')
})
