/**
 * Waveform peaks are computed once, however many callers ask.
 *
 * The bug was two-fold and neither part was visible in a screenshot.
 *
 * **The trigger.** `Timeline.tsx` had an effect that asked for peaks for every
 * clip on the audio lane. Keyed on the *lane*, it re-ran on every `pointermove`
 * of an audio-lane drag, because a drag rewrites the lane.
 *
 * **The amplifier.** `peaksFor` short-circuited only on `peaksBy[assetId]`, which
 * is set when a pass *finishes*. So every caller arriving during a decode started
 * its own — and `computePeaks` walks the entire decoded buffer. Measured: 60
 * entries during a one-second drag.
 *
 * Peaks belong to a file, not to a clip, so the effect is keyed on the asset list
 * and the in-flight promise is shared. This drives the real `createAssets` with
 * fakes, because that is the only place the two halves meet.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { createAssets, type AssetDeps } from '../src/app/store/assets.ts'
import { emptyProject, type Project } from '../src/model/project.ts'
import { createSelection } from '../src/app/store/selection.ts'

const fakeBuffer = () => {
  const samples = new Float32Array(480_000) // ten seconds
  samples.fill(0.5)
  return {
    length: samples.length,
    numberOfChannels: 1,
    sampleRate: 48000,
    getChannelData: () => samples,
  } as unknown as AudioBuffer
}

/**
 * `createAssets` with just enough of the world to reach `peaksFor`.
 *
 * A real `decodedAudio` that resolves on a deferred promise, so the window where
 * several callers overlap is one the test controls rather than one it hopes for.
 */
function harness(options: { defer?: boolean } = {}) {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })

  const decoded = () =>
    options.defer ? gate.then(fakeBuffer) : Promise.resolve(fakeBuffer())

  const library = {
    get: (assetId: string) =>
      assetId === 'hasAudio'
        ? { audioTrack: { id: 'at' }, asset: { name: 'voice.m4a' } }
        : undefined,
  }
  const audio = { decodedAudio: () => decoded() }

  const project: Project = { ...emptyProject(), assets: {} }
  const deps = {
    project,
    library,
    audio,
    history: { commit: () => undefined },
    selection: createSelection(project),
    notify: () => undefined,
    setTracks: () => undefined,
    setAsset: () => undefined,
    dropAsset: () => undefined,
    pruneMedia: () => undefined,
    rememberMedia: () => undefined,
    assetsRevision: () => 0,
    playhead: () => 0,
    snapping: () => false,
    pixelsPerSecond: () => 80,
  } as unknown as AssetDeps

  return { assets: createAssets(deps), release }
}

test('concurrent callers share one pass over the buffer', async () => {
  // The observable is the *shape* of the work, not a stopwatch: a shared promise
  // means one decode and one pass over the buffer, and every caller receives the
  // very same array. Timing would be flaky and would say less.
  const { assets, release } = harness({ defer: true })

  const waiting = [assets.peaksFor('hasAudio'), assets.peaksFor('hasAudio'), assets.peaksFor('hasAudio')]
  release()
  const results = await Promise.all(waiting)

  assert.equal(results.length, 3, 'every caller gets an answer')
  for (const r of results) {
    assert.ok(Array.isArray(r), 'and gets the peaks')
    assert.ok(r.length > 0)
  }
  // All three saw the same array, which is only possible if they shared the pass.
  assert.equal(results[0], results[1], 'and the same one')
  assert.equal(results[1], results[2])
})

test('a second wave of callers is still only one pass', async () => {
  // The `peaksBy` short-circuit covers this once the first pass has resolved —
  // which is why the bug needed the *in-flight* window to show up at all. Asserted
  // anyway, because that short-circuit is the reason the window was easy to miss.
  const { assets } = harness()
  const first = await assets.peaksFor('hasAudio')
  const second = await assets.peaksFor('hasAudio')
  assert.equal(first, second, 'the cached array, not a recomputation')
})

test('an asset with no audio track is not a failure', async () => {
  const { assets } = harness()
  assert.equal(await assets.peaksFor('noAudio'), undefined, 'no track, no peaks, no throw')
})

test('a decode that fails is not cached forever', async () => {
  // The in-flight map is cleared in a `finally`, so a rejected pass cannot wedge
  // the waveform off permanently. Same rule `AudioEngine.#bufferFor` follows, for
  // the same reason: a cached failure is indistinguishable from no waveform.
  const project: Project = emptyProject()
  const library = { get: () => ({ audioTrack: { id: 'at' }, asset: { name: 'broken.m4a' } }) }
  let attempts = 0
  const audio = {
    decodedAudio: () => {
      attempts++
      return attempts === 1 ? Promise.reject(new Error('decode blew up')) : Promise.resolve(fakeBuffer())
    },
  }
  const deps = {
    project,
    library,
    audio,
    history: { commit: () => undefined },
    selection: createSelection(project),
    notify: () => undefined,
    setTracks: () => undefined,
    setAsset: () => undefined,
    dropAsset: () => undefined,
    pruneMedia: () => undefined,
    rememberMedia: () => undefined,
    assetsRevision: () => 0,
    playhead: () => 0,
    snapping: () => false,
    pixelsPerSecond: () => 80,
  } as unknown as AssetDeps

  const assets = createAssets(deps)
  assert.equal(await assets.peaksFor('broken'), undefined, 'the failure is reported, not thrown')
  const second = await assets.peaksFor('broken')
  assert.ok(Array.isArray(second) && second.length > 0, 'and the next attempt is allowed to try again')
})