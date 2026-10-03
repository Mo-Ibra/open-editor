/**
 * The review screen's decisions, without a browser.
 *
 * Everything the screen shows comes from `describeMedia`, so this file is the
 * real specification of what a user sees when they open a project whose media
 * did not travel with it.
 *
 * The state that matters is `rejected`: a file is present, and it is *not* the
 * one the cuts were made against. It is reported, never applied — because
 * attaching it produces a project that exports cleanly and is wrong.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { clipUseCount, decideRelink, describeMedia, planBatch, prefilter, type AvailableFile } from '../src/app/store/media-status.ts'
import type { Fingerprint } from '../src/app/store/fingerprint.ts'
import { emptyProject, type Clip, type Project } from '../src/model/project.ts'

interface Shape { size?: number; duration?: number }
const shape = new Map<string, Shape>()

const clip = (id: string, lane: 'video' | 'audio', assetId: string): Clip => {
  const s = shape.get(assetId) ?? {}
  return { id, lane, assetId, in: 0, out: s.duration ?? 5 }
}

const sized = (assetId: string, s: Shape): void => void shape.set(assetId, s)

const project = (...clips: Clip[]): Project => {
  const assets: Project['assets'] = {}
  for (const c of clips) {
    if (assets[c.assetId]) continue
    const s = shape.get(c.assetId) ?? {}
    assets[c.assetId] = {
      id: c.assetId, name: `${c.assetId}.mp4`, duration: s.duration ?? 5, size: s.size ?? 1000, width: 1920, height: 1080,
      rotation: 0, frameRate: 25, variableFrameRate: false, hasVideo: true, hasAudio: true,
      audioSampleRate: 48000, audioChannels: 2, videoCodec: 'avc', audioCodec: 'aac',
    }
  }
  return { ...emptyProject(), assets, video: clips.filter((c) => c.lane === 'video'), audio: clips.filter((c) => c.lane === 'audio') }
}

const want = (over: Partial<Fingerprint> = {}): Fingerprint => ({ size: 1000, duration: 5, quickHash: 'aaa', ...over })
const file = (over: Partial<AvailableFile> = {}): AvailableFile => ({
  assetId: 'a2', name: 'a2.mp4', size: 1000, duration: 5, quickHash: 'aaa', ...over,
})

test('a file this machine holds is attached, full stop', () => {
  const p = project(clip('c1', 'video', 'a1'))
  const [state] = describeMedia(p, { a1: want() }, [{ ...file(), assetId: 'a1' }])
  assert.equal(state?.status, 'attached')
  assert.equal(state?.reason, 'on this machine')
  assert.equal(state?.clipCount, 1)
})

test('an asset imported here has no fingerprint, and is still attached', () => {
  // The fingerprints only exist in an exported file. A project built on this
  // machine has none, and calling that "missing" would be wrong: the bytes are
  // literally the ones the edit was cut from.
  const p = project(clip('c1', 'video', 'a1'))
  const [state] = describeMedia(p, {}, [{ ...file(), assetId: 'a1' }])
  assert.equal(state?.status, 'attached')
})

test('nothing on the machine is missing, and says so', () => {
  const p = project(clip('c1', 'video', 'a1'))
  const [state] = describeMedia(p, { a1: want() }, [])
  assert.equal(state?.status, 'missing')
  assert.equal(state?.reason, 'not on this machine')
})

test('a present file with different content is missing, and says why', () => {
  // The decision under test. Same name, same size, same duration — and
  // different bytes, which means a re-encode. Status is *missing*, because only
  // identical bytes may be attached, and the user decided that by hand.
  //
  // But the reason must not be "not on this machine": it *is* on this machine.
  // Telling someone to go and look for a file they are already looking at is
  // how you convince them the tool is broken.
  const p = project(clip('c1', 'video', 'a1'))
  const [state] = describeMedia(p, { a1: want() }, [file({ quickHash: 'zzz', name: 'a1.mp4' })])
  assert.equal(state?.status, 'missing', 'wrong bytes are never attached')
  assert.match(state!.reason, /content differs/)
  assert.doesNotMatch(state!.reason, /not on this machine/)
})

test('nothing resembling it reads as plain missing', () => {
  // Same outcome, different work: here the file really is elsewhere.
  const p = project(clip('c1', 'video', 'a1'))
  const [state] = describeMedia(p, { a1: want() }, [file({ quickHash: 'zzz', name: 'zzz.mp4' })])
  assert.equal(state?.status, 'missing')
  assert.equal(state?.reason, 'not on this machine')
})

test('an unverifiable near-match is the one case that is rejected', () => {
  // `rejected` is reserved for what we cannot judge: no hash on either side, so
  // same name and size is all the evidence there is. That genuinely needs a
  // person, and it is the case stage 2 exists for.
  const p = project(clip('c1', 'video', 'a1'))
  const unhashed = want({ quickHash: null })
  const [state] = describeMedia(p, { a1: unhashed }, [file({ quickHash: null, name: 'a1.mp4' })])
  assert.equal(state?.status, 'rejected')
  assert.match(state!.reason, /not verified/)
})

test('rejected and missing are different states, because they need different work', () => {
  // A rejection means "there is a candidate you should look at". A missing means
  // "go and find the file". Collapsing them would throw that information away.
  const p = project(clip('c1', 'video', 'a1'))
  const [rejected] = describeMedia(p, { a1: want({ quickHash: null }) }, [file({ quickHash: null, name: 'a1.mp4' })])
  const [missing] = describeMedia(p, { a1: want() }, [])
  assert.equal(rejected?.status, 'rejected')
  assert.equal(missing?.status, 'missing')
  assert.notEqual(rejected?.reason, missing?.reason)
})

test('an exact match elsewhere on the machine counts as attached', () => {
  // The import case: the file is in the bin under a different asset id, but it
  // is byte-for-byte the file the project was cut with.
  const p = project(clip('c1', 'video', 'a1'))
  const [state] = describeMedia(p, { a1: want() }, [file({ assetId: 'other' })])
  assert.equal(state?.status, 'attached')
  assert.equal(state?.reason, 'identical to the exported file')
})

test('a rejection outranks a missing file that more clips depend on', () => {
  // Deliberate, and the reason is worth stating: a rejection is the only state
  // that says "the file you want may already be on your disk, and the app is
  // unsure". Ten broken clips of a file you have to go and fetch is a bigger job
  // but not a more urgent one to hear about.
  //
  // The assets are given distinct sizes *and* durations on purpose. Both of the
  // soft fallbacks (same name and size, same name and duration) would otherwise
  // make one candidate a plausible match for everything, and the test would be
  // asserting nothing.
  sized('used', { size: 1000, duration: 5 })
  sized('rejected', { size: 2000, duration: 20 })
  sized('gone', { size: 3000, duration: 30 })

  const p = project(
    clip('v1', 'video', 'used'), clip('v2', 'video', 'used'), clip('v3', 'video', 'used'),
    clip('r1', 'video', 'rejected'),
    clip('g1', 'video', 'gone'),
  )
  const wanted = {
    used: want({ size: 1000, duration: 5 }),
    // Unhashed, so this is the unverifiable near-match — the only kind that
    // reaches `rejected`, and the only kind that needs a human.
    rejected: want({ size: 2000, duration: 20, quickHash: null }),
    gone: want({ size: 3000, duration: 30 }),
  }
  // Matches `rejected` on size, and nothing else: different size from `used` and
  // `gone`, and far enough off both durations to fall off the soft ladder.
  const available = [file({ quickHash: null, size: 2000, duration: 20, name: 'untitled.mp4' })]

  const states = describeMedia(p, wanted, available)
  assert.deepEqual(
    states.map((s) => [s.assetId, s.status]),
    [['rejected', 'rejected'], ['used', 'missing'], ['gone', 'missing']],
    'rejection first, then missing ordered by how many clips break',
  )
  assert.equal(states[1]?.clipCount, 3, 'three clips depend on `used`')
})

test('clipUseCount counts across both lanes', () => {
  const p = project(clip('v1', 'video', 'a1'), clip('a1x', 'audio', 'a1'), clip('a2', 'audio', 'a2'))
  assert.equal(clipUseCount(p, 'a1'), 2)
  assert.equal(clipUseCount(p, 'a2'), 1)
  assert.equal(clipUseCount(p, 'nope'), 0)
})

// --- relinking --------------------------------------------------------------

test('a relink to the identical file is accepted', () => {
  assert.deepEqual(decideRelink(want(), file()), { ok: true, reason: 'identical' })
})

test('a relink to different bytes is refused, with the reason shown', () => {
  const out = decideRelink(want(), file({ quickHash: 'zzz' }))
  assert.equal(out.ok, false)
  assert.match(out.reason, /content differs/)
})

test('relinking something with no fingerprint recorded is allowed', () => {
  // Refusing here would make an imported project impossible to fix by hand,
  // which is worse than an unverified acceptance the user chose deliberately.
  const out = decideRelink(null, file({ quickHash: 'zzz' }))
  assert.equal(out.ok, true)
  assert.match(out.reason, /no fingerprint/)
})

test('a different size is a refusal even when hashing is unavailable', () => {
  const out = decideRelink(want({ quickHash: null, size: 1000 }), file({ quickHash: null, size: 9999 }))
  assert.equal(out.ok, false)
})

// --- batch relinking: one folder, one project -------------------------------

test('prefilter keeps a file sharing a size, and drops one sharing nothing', () => {
  // The cost model: hashing a gigabyte to learn it is not the file is minutes of
  // frozen tab. Name and size are free, so they decide what is worth reading.
  const target = want({ size: 1000, duration: 10 })
  assert.equal(prefilter(target, file({ size: 1000, duration: 99, name: 'x.mov' })), true, 'same size')
  assert.equal(
    prefilter(target, file({ size: 1000, duration: 10, name: 'completely-different.mov' })),
    true,
    'same size and duration',
  )
  assert.equal(prefilter(target, file({ size: 4242, duration: 300, name: 'x.mov' })), false, 'nothing in common')
  // A zero-size file is not evidence of anything; matching on it would let every
  // empty placeholder in a folder through to the hasher.
  assert.equal(prefilter(want({ size: 0 }), file({ size: 0, duration: 0 })), false, 'zero size proves nothing')
})

test('an asset with no fingerprint is never batch-matched', () => {
  // Imported on this machine, so there is nothing to match against. Guessing
  // would attach whichever file happened to be first in the folder.
  const p = project(clip('c1', 'video', 'a1'))
  assert.deepEqual(planBatch(p, {}, [file()]), [])
})

test('a certain match is found even when the file was renamed', () => {
  const p = project(clip('c1', 'video', 'a1'))
  const items = planBatch(p, { a1: want() }, [file({ assetId: 'f1', name: 'final_v2_REAL.mov' })])
  assert.equal(items.length, 1)
  assert.equal(items[0]?.certain?.file.assetId, 'f1')
  assert.deepEqual(items[0]?.proposals, [])
})

test('one file backs at most one asset', () => {
  // The property that makes "Relink all proposals" safe. Without it, five assets
  // are each offered the same plausible file and the batch attaches it five
  // times: an edit that saves and exports cleanly and is not the one you made.
  sized('a', { size: 1000, duration: 5 })
  sized('b', { size: 1000, duration: 5 })
  const p = project(clip('v1', 'video', 'a'), clip('v2', 'video', 'b'))
  const wanted = { a: want({ quickHash: null }), b: want({ quickHash: null }) }
  const items = planBatch(p, wanted, [file({ assetId: 'f1', quickHash: null, name: 'one.mov' })])

  const offers = items.flatMap((i) => i.proposals.map((c) => c.file.assetId))
  assert.equal(new Set(offers).size, offers.length, 'no file is offered twice')
  assert.equal(items.filter((i) => i.proposals.length > 0).length, 1, 'only one asset gets it')
  assert.equal(items.filter((i) => i.proposals.length === 0).length, 1, 'the other is left to be found')
})

test('a certain match claims its file before any proposal can', () => {
  // Two assets, one file. The unhashed one would happily take it as a proposal,
  // and if that were gathered first the list would offer a file the certain match
  // already owns — so "relink all proposals" would attach it twice.
  sized('soft', { size: 1000, duration: 5 })
  sized('exact', { size: 1000, duration: 5 })
  const p = project(clip('v1', 'video', 'soft'), clip('v2', 'video', 'exact'))
  const items = planBatch(p, {
    soft: want({ quickHash: null }),
    exact: want({ quickHash: 'aaa' }),
  }, [file({ assetId: 'f1', quickHash: 'aaa', name: 'one.mov' })])

  const exact = items.find((i) => i.assetId === 'exact')
  const soft = items.find((i) => i.assetId === 'soft')
  assert.equal(exact?.certain?.file.assetId, 'f1', 'the certain match has it')
  assert.deepEqual(soft?.proposals, [], 'and nobody is offered a file that is taken')
})

test('already-attached assets are skipped', () => {
  // The folder is for fixing what is broken, not for re-deciding what works.
  sized('a', { size: 1000, duration: 5 })
  const p = project(clip('v1', 'video', 'a'))
  const items = planBatch(p, { a: want() }, [file()], new Set(['a']))
  assert.deepEqual(items, [])
})

test('resolved assets come first, then the most broken', () => {
  sized('s1', { size: 1000, duration: 5 })
  sized('m1', { size: 2000, duration: 20 })
  sized('m2', { size: 3000, duration: 30 })
  const p = project(
    clip('a1', 'video', 's1'),
    clip('b1', 'video', 'm1'), clip('b2', 'video', 'm1'), clip('b3', 'video', 'm1'),
    clip('c1', 'video', 'm2'),
  )
  const items = planBatch(p, {
    s1: want(), m1: want({ size: 2000, duration: 20 }), m2: want({ size: 3000, duration: 30 }),
  }, [file({ assetId: 'f1', quickHash: 'aaa', name: 'one.mov' })])

  assert.equal(items[0]?.assetId, 's1', 'the one that resolves leads')
  assert.equal(items[1]?.assetId, 'm1', 'then the missing one three clips need')
  assert.equal(items[2]?.assetId, 'm2', 'then the one a single clip needs')
})
