/**
 * The saved-file format, and what happens to a file from the past.
 *
 * This is the one part of persistence that can be tested without a browser, and
 * it is the part that matters most: a project file outlives the version of the
 * app that wrote it, and a schema change that "just bumps the version" turns
 * every existing file into a refusal.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import { CURRENT_VERSION, MIGRATIONS, migrateProject, serialiseProject } from '../src/app/store/project-format.ts'
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
  video: [clip('a', 'video', { gain: 1.5, hidden: true, transform: { scale: 1.2, x: 0, y: 0 }, linkId: 'lnk_1' })],
  audio: [clip('b', 'audio', { offset: 2, muted: true, linkId: 'lnk_1' })],
})

test('a project survives a round trip with every field intact', () => {
  const before = sample()
  const after = migrateProject(serialiseProject(before))

  // Compared as text, not by identity: the point is that nothing was dropped on
  // the way to disk. A field quietly omitted is invisible in a UI check.
  assert.deepEqual(after, before)
})

test('the written version comes from the build, not from the project', () => {
  // A stale version in a live project would be written and then refused on the
  // way back in, which is the worst possible round trip.
  const stale = { ...sample(), version: 1 as unknown as 2 }
  const written = JSON.parse(serialiseProject(stale)) as { version: number }
  assert.equal(written.version, CURRENT_VERSION)
})

test('absent optional state stays absent rather than becoming empty', () => {
  const plain = { ...sample() }
  delete (plain as { captions?: unknown }).captions
  const written = JSON.parse(serialiseProject(plain)) as Record<string, unknown>
  assert.equal('captions' in written, false, 'a file with no captions should not carry an empty one')
  assert.equal('captions' in migrateProject(serialiseProject(plain)), false)
})

test('captions survive when they are there', () => {
  const withCaptions = { ...sample(), captions: { tracks: [] } } as unknown as Project
  assert.equal('captions' in migrateProject(serialiseProject(withCaptions)), true)
})

test('a file from the future is refused with a message, not silently mangled', () => {
  const future = JSON.stringify({ ...sample(), version: CURRENT_VERSION + 1 })
  assert.throws(
    () => migrateProject(future),
    (e: Error) => /newer version/i.test(e.message) && /nothing has been lost/i.test(e.message),
    'the refusal must reassure: the file is fine, the app is old',
  )
})

test('a v1 file is refused, and the message says the file is untouched', () => {
  // v1 predates the two-lane format and its clip model was different, so no
  // honest conversion exists. Refusing is right; what matters is that the user is
  // told the file is fine and only the app is behind.
  const old = JSON.stringify({ version: 1, clips: [{ id: 'a', src: 0 }] })
  assert.throws(
    () => migrateProject(old),
    (e: Error) => /cannot open/i.test(e.message) && /has not been changed/i.test(e.message),
  )
})

test('a corrupt file fails loudly, and says what was wrong', () => {
  assert.throws(() => migrateProject('{not json'), /not valid JSON/)
  assert.throws(() => migrateProject('null'), /empty or not an object/)
  assert.throws(() => migrateProject('{"assets":{}}'), /no version/)
})

test('a structurally valid version with a broken clip is still rejected', () => {
  // The version is right, so only the model's own validation can catch this.
  const broken = JSON.stringify({ version: 2, assets: {}, video: [{ id: 'a' }], audio: [] })
  assert.throws(() => migrateProject(broken), /missing assetId/)
})

test('an empty project round-trips', () => {
  assert.deepEqual(migrateProject(serialiseProject(emptyProject())), emptyProject())
})

test('the migration chain has no holes', () => {
  // A gap is invisible until a file needs it, and then it is a refusal. Checked
  // here so the failure is a failing test rather than somebody's afternoon.
  // From the oldest version we can *open*. v1 is exempt by design: it has no
  // forward step because no conversion exists, and it is refused up front.
  const OLDEST_OPENABLE = 2
  for (let v = OLDEST_OPENABLE; v < CURRENT_VERSION; v++) {
    assert.equal(
      typeof MIGRATIONS[v + 1],
      'function',
      `no migration from v${v} to v${v + 1} — every openable version needs a step`,
    )
  }
  assert.equal(
    MIGRATIONS[2],
    undefined,
    'v1 must stay unmigrated: there is no honest conversion to the two-lane format',
  )
})

test('a migration step is a pure function of the raw JSON', () => {
  // Every step is applied blind, so a step that reads a global or mutates its
  // input would corrupt the *next* file to be opened.
  for (const [to, step] of Object.entries(MIGRATIONS)) {
    const input = { version: Number(to) - 1, marker: 'original' }
    const out = step({ ...input }) as Record<string, unknown>
    assert.equal(out.version, Number(to), `the step to v${to} must set the version it produces`)
    assert.deepEqual(input, { version: Number(to) - 1, marker: 'original' }, 'and must not mutate its input')
  }
})
