/**
 * The store actually builds and the slices are actually wired.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { clipStart } from '../src/model/project.ts'

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
;(g.window as { AudioContext?: unknown }).AudioContext ??= g.AudioContext

const { createAppState } = await import('../src/app/store/state.ts')
const { frameRateFor } = await import('../src/app/store/transport.ts')

function videoClips(state: ReturnType<typeof createAppState>) {
  return state.project.tracks.find((t) => t.type === 'video')!.clips
}
function audioClips(state: ReturnType<typeof createAppState>) {
  return state.project.tracks.find((t) => t.type === 'audio')!.clips
}

test('the store builds', () => {
  const state = createAppState()
  assert.ok(state.project, 'a project exists')
  assert.equal(state.project.version, 3)
  assert.equal(state.duration(), 0, 'an empty timeline is zero seconds long')
})

test('every slice is reachable from the composed surface', () => {
  const state = createAppState()
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
  assert.equal(state.selectedClip(), null)
  assert.equal(state.selectedIsLinked(), false)
  assert.equal(state.selectedPartner(), null)
  assert.equal(state.findClipById('does-not-exist'), null)
  assert.deepEqual(state.selectedTracks(), [])
})

test('every action is safe to call against an empty timeline', () => {
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
  noThrow('clearTrack', () => state.clearTrack('video'))
  noThrow('clearTrack audio', () => state.clearTrack('audio'))
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
  const state = createAppState()
  state.seek(5)
  assert.equal(state.playhead(), 0)
  state.seek(-10)
  assert.equal(state.playhead(), 0)
})

test('transport reads the playhead it was given', () => {
  const state = createAppState()
  videoClips(state).push({ id: 'a', trackId: 'video', assetId: 'a', in: 0, out: 10 })
  assert.equal(state.duration(), 10, 'the track is 10 seconds long')

  state.seek(5)
  assert.equal(state.playhead(), 5)
  state.step(1)
  assert.ok(state.playhead() > 5 && state.playhead() < 5.1, `stepped one frame, got ${state.playhead()}`)
  state.step(-1)
  assert.ok(Math.abs(state.playhead() - 5) < 1e-9, 'and back again')

  state.seek(-10)
  assert.equal(state.playhead(), 0, 'clamped at the start')
  state.seek(1e9)
  assert.equal(state.playhead(), 10, 'and at the end')
})

test('stopping playback stops the audio, not just the flag', async () => {
  const state = createAppState()
  videoClips(state).push({ id: 'v1', trackId: 'video', assetId: 'a', in: 0, out: 10 })
  audioClips(state).push({ id: 'a1', trackId: 'audio', assetId: 'a', in: 0, out: 10 })

  await state.togglePlay()
  assert.equal(state.playing(), true)
  assert.equal(state.audio.running, true, 'the engine is what makes the sound')

  state.setPlaying(false)
  assert.equal(state.playing(), false)
  assert.equal(state.audio.running, false, 'and it stopped with the flag')

  state.setPlaying(false)
  assert.equal(state.audio.running, false)
})

test('a seek in flight cannot resurrect a stopped transport', async () => {
  const state = createAppState()
  videoClips(state).push({ id: 'v1', trackId: 'video', assetId: 'a', in: 0, out: 10 })
  audioClips(state).push({ id: 'a1', trackId: 'audio', assetId: 'a', in: 0, out: 10 })
  await state.togglePlay()

  state.seek(5)
  state.setPlaying(false)
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(state.playing(), false)
  assert.equal(state.audio.running, false, 'the cancelled run did not start')
})

test('the playhead cannot outlive the timeline', () => {
  const state = createAppState()
  videoClips(state).push({ id: 'v1', trackId: 'video', assetId: 'a', in: 0, out: 30 })
  state.selectClip('v1')
  state.seek(20)
  assert.equal(state.playhead(), 20)

  state.deleteSelected()
  assert.equal(state.duration(), 0, 'the timeline is empty')
  assert.equal(state.playhead(), 0, 'so the playhead was pulled back inside it')
})

test('the playhead is pulled back when a track is cleared', () => {
  const state = createAppState()
  videoClips(state).push({ id: 'v1', trackId: 'video', assetId: 'a', in: 0, out: 10 })
  audioClips(state).push({ id: 'a1', trackId: 'audio', assetId: 'a', in: 0, out: 40 })
  state.seek(35)
  assert.equal(state.playhead(), 35, 'past the end of the video track, inside the timeline')

  state.clearTrack('audio')
  assert.equal(state.duration(), 10, 'only the video track is left')
  assert.equal(state.playhead(), 10, 'so the playhead came back to the new end')
})

test('a project write that does not shorten the timeline leaves the playhead alone', () => {
  const state = createAppState()
  videoClips(state).push({ id: 'v1', trackId: 'video', assetId: 'a', in: 0, out: 30 })
  state.selectClip('v1')
  state.seek(20)

  state.reorder('video', 0, 0)
  assert.equal(state.playhead(), 20, 'untouched')
})

test('a split that split nothing costs nothing', () => {
  const state = createAppState()
  videoClips(state).push({ id: 'v1', trackId: 'video', assetId: 'a', in: 0, out: 10 })
  state.selectClip('v1')
  assert.equal(state.canUndo(), false, 'a fresh timeline has no history')

  state.seek(50)
  state.splitAt(state.playhead())
  assert.equal(videoClips(state).length, 1, 'nothing was split')
  assert.equal(state.canUndo(), false, 'and nothing was recorded')

  state.seek(5)
  state.splitAt(state.playhead())
  assert.equal(videoClips(state).length, 2, 'a real split still happens')
  assert.equal(state.canUndo(), true, 'and is recorded')

  state.undo()
  assert.equal(videoClips(state).length, 1, 'undo took it straight back')
})

test('a split refused as too close to an edge costs nothing either', () => {
  const state = createAppState()
  videoClips(state).push({ id: 'v1', trackId: 'video', assetId: 'a', in: 0, out: 10 })
  state.selectClip('v1')

  state.seek(0.02)
  state.splitSelectionAtPlayhead()
  assert.equal(videoClips(state).length, 1, 'not split')
  assert.equal(state.canUndo(), false, 'and not recorded')
  assert.match(state.notices().at(-1)?.text ?? '', /Nothing to split/, 'and it says so')

  state.seek(5)
  state.splitSelectionAtPlayhead()
  assert.equal(videoClips(state).length, 2)
  assert.equal(state.canUndo(), true)
  assert.match(state.notices().at(-1)?.text ?? '', /Split 1 clip\./)
})

test('cutting a linked pair keeps each half paired to its own sound', () => {
  const state = createAppState()
  videoClips(state).push({ id: 'v1', trackId: 'video', assetId: 'a', in: 0, out: 20, linkId: 'L' })
  audioClips(state).push({ id: 'a1', trackId: 'audio', assetId: 'a', in: 0, out: 20, linkId: 'L' })

  state.selectAll()
  state.seek(5)
  state.splitAt(state.playhead())
  assert.equal(videoClips(state).length, 2, 'picture split')
  assert.equal(audioClips(state).length, 2, 'sound split with it')

  state.selectAll()
  state.seek(10)
  state.splitAt(state.playhead())
  assert.equal(videoClips(state).length, 3, 'second picture cut')
  assert.equal(audioClips(state).length, 3, 'and the sound followed')
})

test('split cuts only the selected track', () => {
  const state = createAppState()
  videoClips(state).push({ id: 'v1', trackId: 'video', assetId: 'a', in: 0, out: 20, linkId: 'L' })
  audioClips(state).push({ id: 'a1', trackId: 'audio', assetId: 'a', in: 0, out: 20, linkId: 'L' })

  state.selectClip('v1')
  state.seek(5)
  state.splitAt(state.playhead())
  assert.equal(videoClips(state).length, 2, 'the picture split')
  assert.equal(audioClips(state).length, 1, 'and the sound did not')

  state.selectClip('a1')
  state.seek(15)
  state.splitAt(state.playhead())
  assert.equal(audioClips(state).length, 2, 'now the sound split')
  assert.equal(videoClips(state).length, 2, 'and the picture count did not change')
})

test('split with nothing selected cuts both tracks', () => {
  const state = createAppState()
  videoClips(state).push({ id: 'v1', trackId: 'video', assetId: 'a', in: 0, out: 20, linkId: 'L' })
  audioClips(state).push({ id: 'a1', trackId: 'audio', assetId: 'a', in: 0, out: 20, linkId: 'L' })

  state.clearSelection()
  state.seek(5)
  state.splitAt(state.playhead())
  assert.equal(videoClips(state).length, 2)
  assert.equal(audioClips(state).length, 2)
})

test('split cuts the clip under the playhead in the selected track', () => {
  const state = createAppState()
  videoClips(state).push({ id: 'a', trackId: 'video', assetId: 'a', in: 0, out: 10 })
  videoClips(state).push({ id: 'b', trackId: 'video', assetId: 'a', in: 0, out: 10 })

  state.selectClip('a')
  state.seek(15)
  state.splitAt(state.playhead())

  assert.equal(videoClips(state).length, 3, 'the clip under the playhead split')
  assert.equal(videoClips(state)[0]!.id, 'a', 'and the selected-but-not-under-playhead clip is untouched')
  assert.equal(videoClips(state)[0]!.out, 10)
})

test('trim selection trims both halves of a selected pair', () => {
  const state = createAppState()
  videoClips(state).push({ id: 'v1', trackId: 'video', assetId: 'a', in: 0, out: 20, linkId: 'L' })
  audioClips(state).push({ id: 'a1', trackId: 'audio', assetId: 'a', in: 0, out: 20, linkId: 'L' })

  state.clearSelection()
  state.seek(5)
  state.splitAt(state.playhead())
  assert.equal(audioClips(state).length, 2)

  state.selectAll()
  state.seek(18)
  state.trimSelectionToPlayhead()

  assert.equal(videoClips(state)[1]!.out, 18, 'the picture was trimmed to the playhead')
  assert.equal(audioClips(state)[1]!.out, 18, 'and so was the sound')
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
  const state = createAppState()
  state.project.assets['ast_1'] = {
    id: 'ast_1', name: 'a.mp4', duration: 5, width: 1920, height: 1080, rotation: 0,
    frameRate: 30, variableFrameRate: false, hasVideo: true, hasAudio: true,
    audioSampleRate: 48000, audioChannels: 2, videoCodec: 'avc', audioCodec: 'aac', size: 10,
  }
  videoClips(state).push({ id: 'c1', trackId: 'video', assetId: 'ast_1', in: 0, out: 5 })

  assert.deepEqual(state.assetIds(), ['ast_1'])
  state.removeAsset('ast_1')

  assert.deepEqual(state.assetIds(), [], 'the asset is gone from the bin')
  assert.equal(state.project.assets['ast_1'], undefined, 'and from the project map')
  assert.equal(videoClips(state).length, 0, 'and its clips with it')
})

test('moving a multi-selection shifts every selected clip', () => {
  const state = createAppState()
  videoClips(state).push({ id: 'a', trackId: 'video', assetId: 'x', in: 0, out: 5 })
  videoClips(state).push({ id: 'b', trackId: 'video', assetId: 'x', in: 0, out: 5 })

  state.selectClip('a')
  state.selectClip('b', 'toggle')
  state.moveSelection('video', 0, 7)

  assert.deepEqual(
    videoClips(state).map((_, i) => clipStart(videoClips(state), i)),
    [7, 12],
    'the whole selection moved together',
  )
})

test('the three snap toggles are independent', () => {
  const state = createAppState()
  assert.equal(state.clipSnap(), true, 'clip snap starts on')
  assert.equal(state.laneSnap(), true, 'lane snap starts on')
  assert.equal(state.playheadSnap(), true, 'playhead snap starts on')

  state.setClipSnap(false)
  state.setLaneSnap(false)
  assert.equal(state.snapping(), false, 'the clip/lane gate is off')
  assert.equal(state.playheadSnap(), true, 'and playhead snapping is untouched')

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

test('a drop honours the snap toggles, in the track it is aimed at', () => {
  const state = createAppState()
  state.project.assets.a = {
    id: 'a', name: 'a.mp4', duration: 10, width: 1920, height: 1080, rotation: 0,
    frameRate: 30, variableFrameRate: false, hasVideo: true, hasAudio: true,
    audioSampleRate: 48000, audioChannels: 2, videoCodec: 'avc', audioCodec: 'aac', size: 10,
  }
  videoClips(state).push({ id: 'v1', trackId: 'video', assetId: 'a', in: 0, out: 10 })
  state.setZoom(80)
  state.seek(0)

  const near = 9.95
  assert.equal(state.dropTimeFor(near, 'video'), 10, 'with clip snap on, it snaps to the same-track edge')

  state.setClipSnap(false)
  state.setLaneSnap(true)
  assert.equal(
    state.dropTimeFor(near, 'video'),
    near,
    'with clip snap OFF, a same-track edge is not a target, even though lane snap is on',
  )
  assert.equal(
    state.dropTimeFor(near, 'audio'),
    10,
    'and on the audio track, lane snap means the video track — which is still eligible',
  )

  state.setLaneSnap(false)
  assert.equal(state.dropTimeFor(near, 'video'), near, 'both off means no snapping at all')

  state.setClipSnap(true)
  state.setLaneSnap(true)
  assert.equal(state.dropTimeFor(near, 'video'), 10)
  assert.equal(state.dropTimeFor(near, 'audio'), 10)
})

test('the frame rate playback steps by is the source\'s, not the output\'s', () => {
  const at24 = { frameRate: 24, variableFrameRate: false } as never
  const at30 = { frameRate: 30, variableFrameRate: false } as never
  const vfr = { frameRate: 4, variableFrameRate: true } as never

  assert.equal(frameRateFor(at24), 24, 'a 24fps source steps 24')
  assert.equal(frameRateFor(at30), 30)
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
  videoClips(state).push({ id: 'v1', trackId: 'video', assetId: 'a', in: 0, out: 30 })
  state.seek(5)
  state.step(1)
  assert.ok(Math.abs(state.playhead() - (5 + 1 / 24)) < 1e-9, `one 24fps frame, got ${state.playhead()}`)

  state.seek(5)
  for (let i = 0; i < 10; i++) state.step(1)
  assert.ok(Math.abs(state.playhead() - (5 + 10 / 24)) < 1e-9, 'and ten of them add up')

  state.project.assets.a = asset(4, true)
  state.seek(5)
  state.step(1)
  assert.ok(Math.abs(state.playhead() - (5 + 1 / 30)) < 1e-9, 'a VFR source steps at the output rate')

  state.seek(0)
  videoClips(state).length = 0
  state.selectClip('nope')
  state.step(-1)
  assert.equal(state.playhead(), 0, 'clamped at the start, and no throw')
})

test('a new video track joins the video group, above the audio ones', () => {
  const state = createAppState()
  state.addTrack('video')

  assert.deepEqual(
    state.project.tracks.map((t) => t.type),
    ['video', 'video', 'audio'],
    'the new video track sits between the video and audio groups, not after the audio',
  )
  assert.notEqual(state.project.tracks[1]!.id, 'video', 'it is a distinct track')
  assert.equal(state.project.tracks[1]!.clips.length, 0, 'and starts empty')
})

test('a new audio track is appended below the audio ones', () => {
  const state = createAppState()
  state.addTrack('audio')
  assert.deepEqual(state.project.tracks.map((t) => t.type), ['video', 'audio', 'audio'])
  assert.equal(state.project.tracks.at(-1)!.clips.length, 0)
})

test('adding and removing a track is one undo step', () => {
  const state = createAppState()
  const before = state.project.tracks.length
  state.addTrack('video')
  assert.equal(state.project.tracks.length, before + 1)
  assert.equal(state.canUndo(), true, 'adding structure is undoable')

  state.undo()
  assert.equal(state.project.tracks.length, before, 'undo restores the track list')

  state.removeTrack('audio')
  assert.equal(state.project.tracks.length, before - 1, 'an empty track can be removed')
  state.undo()
  assert.equal(state.project.tracks.length, before, 'and that is undoable too')
})

test('a track with clips is not removed out from under them', () => {
  const state = createAppState()
  videoClips(state).push({ id: 'v1', trackId: 'video', assetId: 'a', in: 0, out: 5 })
  const before = state.project.tracks.length
  state.removeTrack('video')
  assert.equal(state.project.tracks.length, before, 'a non-empty track is refused')
})

test('the last track cannot be removed, so the timeline is never empty', () => {
  const state = createAppState()
  state.removeTrack('audio')
  assert.equal(state.project.tracks.length, 1)
  state.removeTrack(state.project.tracks[0]!.id)
  assert.equal(state.project.tracks.length, 1, 'the final track stays')
})
