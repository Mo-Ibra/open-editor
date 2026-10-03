/**
 * The portable project file, and the fingerprint ladder.
 *
 * This is the part that travels between machines, so the tests are about two
 * things: nothing is lost in a round trip, and the matcher never claims a
 * certainty it does not have.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  EXPORT_FORMAT_VERSION,
  buildProjectFile,
  parseProjectFile,
  fingerprintFor,
} from '../src/app/store/project-file.ts'
import {
  fingerprintOf,
  hashingAvailable,
  isCertain,
  matchFingerprint,
  quickHash,
} from '../src/app/store/fingerprint.ts'
import { emptyProject, type Clip, type Project } from '../src/model/project.ts'

const clip = (id: string, lane: 'video' | 'audio', over: Partial<Clip> = {}): Clip => ({
  id, lane, assetId: 'ast_1', in: 1.5, out: 4.25, ...over,
})

const sample = (): Project => ({
  version: 2,
  assets: {
    ast_1: {
      id: 'ast_1', name: 'clip.mp4', duration: 10, width: 1920, height: 1080,
      rotation: 0, frameRate: 25, variableFrameRate: false,
      hasVideo: true, hasAudio: true, audioSampleRate: 48000, audioChannels: 2,
      videoCodec: 'avc', audioCodec: 'aac', size: 1234,
    },
  },
  video: [clip('a', 'video', { gain: 1.5, hidden: true, transform: { scale: 1.2, x: 0, y: 0 } })],
  audio: [clip('b', 'audio', { offset: 2, muted: true, linkId: 'L' })],
})

// --- round trip -------------------------------------------------------------

test('an exported project comes back exactly as it went out', () => {
  const before = sample()
  const media = { ast_1: { size: 1234, duration: 10, quickHash: 'abc123' } }
  const after = parseProjectFile(buildProjectFile(before, media, { playhead: 7.5, selection: ['a'] }))

  assert.deepEqual(after.project, before, 'the edit must be identical, not merely similar')
  assert.equal(after.playhead, 7.5, 'and it reopens where you left off')
  assert.deepEqual(after.selection, ['a'])
  assert.deepEqual(after.media, media, 'the fingerprints travel with it')
})

test('the envelope is plain JSON you can read', () => {
  const text = buildProjectFile(sample(), {})
  assert.deepEqual(JSON.parse(text), JSON.parse(text), 'it parses')
  assert.match(text, /^\{\n {2}"format": "open-editor.project"/, 'formatted, with the format named up front')
  // Newlines and tabs are expected in formatted JSON; what must not appear is
  // anything non-ASCII, which is what "binary smuggled in" would look like.
  assert.doesNotMatch(text, /[^\x09\x0a\x0d\x20-\x7e]/, 'nothing non-ASCII in the file')
})

test('the model never sees the fingerprint fields', () => {
  // The whole point of keeping them in `media`: `parseProject` gets exactly the
  // shape it already handles, so the editing core is untouched by this feature.
  const after = parseProjectFile(buildProjectFile(sample(), { ast_1: { size: 1, duration: 2, quickHash: 'q' } }))
  assert.equal('media' in after.project, false, 'the project itself has no fingerprint bag')
})

test('an asset with no recorded fingerprint still opens the edit', () => {
  const after = parseProjectFile(buildProjectFile(sample(), {}))
  assert.equal(after.project.video.length, 1, 'the clips are all there')
  assert.equal(fingerprintFor(after.media, 'ast_1'), null)
})

// --- refusals ---------------------------------------------------------------

test('a file that is not ours says so', () => {
  assert.throws(() => parseProjectFile('{"format":"something.else"}'), /not exported from this editor/)
  assert.throws(() => parseProjectFile('{}'), /not exported from this editor/)
})

test('a file from a newer build is refused, and the file is blamed nowhere', () => {
  const newer = JSON.parse(buildProjectFile(sample(), {}))
  newer.formatVersion = EXPORT_FORMAT_VERSION + 1
  assert.throws(
    () => parseProjectFile(JSON.stringify(newer)),
    (e: Error) => /newer version/i.test(e.message) && /has not been changed/i.test(e.message),
  )
})

test('damaged input is distinguishable from the wrong file', () => {
  // Three different problems need three different answers: update the app,
  // re-export, or send it to someone. One "cannot open" for all three leaves the
  // user guessing.
  assert.throws(() => parseProjectFile('{not json'), /not valid JSON/)
  assert.throws(() => parseProjectFile('null'), /empty or not a project/)
  const bad = JSON.parse(buildProjectFile(sample(), {}))
  delete (bad.project as Partial<Project>).video
  assert.throws(() => parseProjectFile(JSON.stringify(bad)), /video and an audio lane/)
})

test('a saved project file can be imported as a saved project file', () => {
  // The two formats are different things, and this is the case that makes the
  // difference obvious: an export carries an envelope, a save does not.
  const exported = buildProjectFile(sample(), {})
  assert.equal(parseProjectFile(exported).project.version, 2)
  assert.throws(() => parseProjectFile(JSON.stringify(emptyProject())), /not exported/)
})

// --- fingerprints -----------------------------------------------------------

test('a fingerprint hashes a file, and the same file hashes the same', async () => {
  assert.equal(hashingAvailable(), true, 'Node has webcrypto, so this is testable here')
  const data = new Uint8Array(2048).map((_, i) => i % 251)
  const a = new Blob([data])
  const b = new Blob([data])
  assert.equal(await quickHash(a), await quickHash(b), 'stable across equal blobs')
})

test('different content hashes differently, and a different length does too', async () => {
  const a = new Blob([new Uint8Array(1024).fill(1)])
  const same = new Blob([new Uint8Array(1024).fill(1)])
  const different = new Blob([new Uint8Array(1024).fill(2)])
  const longer = new Blob([new Uint8Array(2048).fill(1)])

  assert.equal(await quickHash(a), await quickHash(same))
  assert.notEqual(await quickHash(a), await quickHash(different), 'content matters')
  assert.notEqual(await quickHash(a), await quickHash(longer), 'and so does length, even with identical content')
})

test('fingerprinting reports the size it was given', async () => {
  const f = await fingerprintOf(new Blob([new Uint8Array(64)]), 3.5)
  assert.equal(f.size, 64)
  assert.equal(f.duration, 3.5)
  assert.equal(typeof f.quickHash, 'string')
})

// --- the ladder -------------------------------------------------------------

const fp = (over: Partial<{ size: number; duration: number; quickHash: string | null }> = {}) => ({
  size: 1000,
  duration: 10,
  quickHash: 'aaa' as string | null,
  ...over,
})

test('an identical hash is certain, and that is the only certain thing', () => {
  assert.equal(isCertain(matchFingerprint(fp(), fp(), 'a.mp4', 'a.mp4')), true)
  assert.equal(matchFingerprint(fp(), fp(), 'a.mp4', 'a.mp4').kind, 'identical')

  for (const candidate of [fp({ quickHash: 'bbb' }), fp({ quickHash: null })]) {
    assert.equal(isCertain(matchFingerprint(fp(), candidate, 'a.mp4', 'a.mp4')), false, 'a guess is never certain')
  }
})

test('a matching hash is not enough on its own — the size must agree too', () => {
  // The hash folds the size in, so this should be unreachable. It is checked
  // anyway, because "identical" is the one claim the app acts on without asking,
  // and it should not rest on a coupling between two files that may have been
  // written by different versions of the sampler.
  const sameHashDifferentSize = matchFingerprint(fp({ size: 1000 }), fp({ size: 2000 }), 'a.mp4', 'a.mp4')
  assert.equal(sameHashDifferentSize.kind, 'none')
  assert.equal(isCertain(sameHashDifferentSize), false)
})

test('two hashed files that differ are a definite no, not a proposal', () => {
  // The dangerous case. A re-encode of the same take shares a name and a
  // duration; if the hashes disagree the content is different, and offering it
  // anyway is how a wrong attachment gets one click of rubber-stamping.
  const match = matchFingerprint(fp({ size: 1000 }), fp({ size: 1000, quickHash: 'bbb' }), 'a.mp4', 'a.mp4')
  assert.equal(match.kind, 'none')
  assert.match(match.reason, /content differs/)
})

test('an unhashed file falls back to size, and says it was not verified', () => {
  // Honest degradation: a browser without webcrypto still matches, but the
  // reason says "not verified" so nobody mistakes it for a check.
  const match = matchFingerprint(fp({ quickHash: null }), fp({ quickHash: null }), 'a.mp4', 'a.mp4')
  assert.equal(match.kind, 'same-name-size')
  assert.match(match.reason, /not verified/)
})

test('a same-name match is a proposal, never a certainty', () => {
  const match = matchFingerprint(fp({ quickHash: null, size: 1000 }), fp({ quickHash: null, size: 1000 }), 'a.mp4', 'a.mp4')
  assert.equal(match.kind, 'same-name-size')
  assert.equal(isCertain(match), false, 'this is the one an automatic match must not make')
})

test('size and duration disagreeing is no match', () => {
  const match = matchFingerprint(fp({ quickHash: null, size: 1000, duration: 10 }), fp({ quickHash: null, size: 2000, duration: 90 }), 'a.mp4', 'other.mp4')
  assert.equal(match.kind, 'none')
})


test('the project name survives the round trip', () => {
  // Without it every import landed as "Imported project", which is the one piece
  // of context a person would have recognised instantly — and the whole reason
  // to name a project is so you can find it again.
  const p = emptyProject()
  p.assets.a1 = { ...p.assets.a1!, name: 'a1.mp4' }
  p.video.push({ id: 'c1', lane: 'video', assetId: 'a1', in: 0, out: 5 })

  const text = buildProjectFile(p, {}, { name: 'cut-a' })
  assert.equal(JSON.parse(text).name, 'cut-a')
  assert.equal(parseProjectFile(text).name, 'cut-a')
})

test('a file with no name still opens, under a placeholder', () => {
  // A file from a build that predates the field, or one a person hand-edited.
  // The edit is the irreplaceable part, so a missing label must not stop it.
  const raw = JSON.parse(buildProjectFile(emptyProject(), {}))
  delete raw.name
  const parsed = parseProjectFile(JSON.stringify(raw))
  assert.equal(parsed.name, 'Imported project')
  assert.equal(parsed.project.video.length, 0, 'and the edit is intact')
})

test('a blank name is treated as absent, not as a nameless project', () => {
  const raw = JSON.parse(buildProjectFile(emptyProject(), {}))
  raw.name = '   '
  assert.equal(parseProjectFile(JSON.stringify(raw)).name, 'Imported project')
})

// --- the decision, restated as the thing the app actually does -------------

test('a near-miss is a rejection, not a proposal to apply', () => {
  // The user-facing decision: when the media is present but the content is
  // different, the asset is reported as *missing*. It is not offered for
  // attachment, and it is not silently attached.
  const want = fp({ size: 1000, duration: 10, quickHash: 'aaa' })
  const differentBytes = fp({ size: 1000, duration: 10, quickHash: 'bbb' })
  const match = matchFingerprint(want, differentBytes, 'a.mp4', 'a.mp4')

  assert.equal(match.kind, 'none', 'different content is not a candidate at all')
  assert.equal(isCertain(match), false, 'so it can never be applied without asking')
  assert.match(match.reason, /content differs/)
  // The name still matches, and that is what the reason is allowed to say.
  // Without it the user would be told to go and find the file, when the file
  // they want is already on their disk under the name they expect.
  assert.equal(match.sameName, true)

  // And the one that *is* certain still is, so the happy path is unaffected.
  assert.equal(isCertain(matchFingerprint(want, fp(), 'a.mp4', 'a.mp4')), true)
})
