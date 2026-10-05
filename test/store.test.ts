/**
 * The project store survives an edit.
 *
 * This is a regression test for a bug that cost a whole media library and was
 * invisible in every other test: `setProject` was changed from a plain
 * single-key set to `setProject(reconcile(next))`, and `reconcile` sets any
 * store key the target does not mention to `undefined`. Since an edit only
 * produced `{ tracks }`, every edit silently wiped `project.assets`.
 *
 * The failure surfaced as `Cannot read properties of undefined (reading
 * 'ast_…')` — an asset id read out of a store that no longer had an `assets`
 * key at all. The file on disk was fine; the pointer to it was gone.
 *
 * The fix is `applyTracks`, which does a plain set. This test pins the
 * behaviour, and also pins *why*, so the next person to "optimise" it with
 * `reconcile` finds out immediately.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createStore } from 'solid-js/store'

import { applyTracks, type Tracks } from '../src/model/project-store.ts'
import { emptyProject, splitLinked, removeClip, type Asset, type Clip, type Project } from '../src/model/project.ts'

const asset: Asset = {
  id: 'ast_7fdu42uz',
  name: 'clip.mp4',
  duration: 100,
  width: 1920,
  height: 1080,
  rotation: 0,
  frameRate: 30,
  variableFrameRate: false,
  hasVideo: true,
  hasAudio: true,
  audioSampleRate: 48000,
  audioChannels: 2,
  videoCodec: 'avc',
  audioCodec: 'aac',
  size: 1,
}

function freshStore() {
  const [project, setProject] = createStore({
    ...emptyProject(),
    assets: { [asset.id]: asset },
  })
  // The exact shape state.ts uses for every edit.
  const edit = (tracks: Tracks) => applyTracks((value) => setProject('tracks', value), tracks, () => undefined)
  return { project, setProject, edit }
}

/** A video clip on the timeline, for seeding. */
const vclip = (id: string, out = 10): Clip => ({ id, trackId: 'video', assetId: asset.id, in: 0, out })

const videoClips = (p: Project): Clip[] => p.tracks.find((t) => t.type === 'video')?.clips ?? []

test('an edit leaves the asset library intact', () => {
  const { project, edit } = freshStore()

  edit(project.tracks.map((t) => (t.type === 'video' ? { ...t, clips: [vclip('a')] } : t)))

  assert.ok(project.assets, 'project.assets must still be an object after an edit')
  assert.equal(project.assets[asset.id]?.name, 'clip.mp4')
  assert.equal(project.version, emptyProject().version)
})

test('the asset is still reachable by the id the library handed out', () => {
  // The exact expression that threw in the browser.
  const { project, edit } = freshStore()

  edit(project.tracks.map((t) => (t.type === 'video' ? { ...t, clips: [vclip('a')] } : t)))

  assert.equal(project.assets['ast_7fdu42uz']?.id, 'ast_7fdu42uz')
})

test('a real edit — splitting a clip — keeps the library', () => {
  const { project, edit } = freshStore()
  // Seed one clip through the same path an import would use.
  edit(project.tracks.map((t) => (t.type === 'video' ? { ...t, clips: [vclip('a')] } : t)))

  const split = splitLinked({ ...project, tracks: project.tracks.map((t) => ({ ...t, clips: [...t.clips] })) }, 'video', 0, 4)
  edit(split.tracks)

  assert.equal(videoClips(project).length, 2, 'the split happened')
  assert.equal(project.assets[asset.id]?.name, 'clip.mp4', 'and the library survived it')
})

test('deleting a clip keeps the library', () => {
  const { project, edit } = freshStore()
  edit(project.tracks.map((t) => (t.type === 'video' ? { ...t, clips: [vclip('a'), vclip('b')] } : t)))

  const after = removeClip({ ...project, tracks: project.tracks.map((t) => ({ ...t, clips: [...t.clips] })) }, 'video', 0)
  edit(after.tracks)

  assert.equal(videoClips(project).length, 1)
  assert.equal(project.assets[asset.id]?.name, 'clip.mp4')
})

test('the write is a plain set: one value, one call', () => {
  // Guards the fix directly. If someone swaps the plain set for `reconcile`,
  // the setter receives a recipe function instead of the exact tracks value,
  // and this fails even if the other tests happen to pass.
  const calls: unknown[] = []
  const tracks: Tracks = []

  applyTracks(
    (value) => calls.push(value),
    tracks,
    () => undefined,
  )

  assert.equal(calls.length, 1, 'a single write, so a single notification')
  assert.equal(calls[0], tracks, 'the exact value handed through, not a merge of it')
})

test('the post-write hook runs after the write, not before', () => {
  // pruneSelection reads the project to see which clips still exist. If it ran
  // first it would prune against the previous project and keep dead ids.
  const order: string[] = []

  applyTracks(
    () => {
      order.push('write')
    },
    [],
    () => {
      order.push('prune')
    },
  )

  assert.deepEqual(order, ['write', 'prune'])
})
