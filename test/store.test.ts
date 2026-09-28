/**
 * The project store survives an edit.
 *
 * This is a regression test for a bug that cost a whole media library and was
 * invisible in every other test: `setProject` was changed from a plain two-key
 * set to `setProject(reconcile(next))`, and `reconcile` sets any store key the
 * target does not mention to `undefined`. Since the target was only
 * `{ video, audio }`, every edit silently wiped `project.assets`.
 *
 * The failure surfaced as `Cannot read properties of undefined (reading
 * 'ast_…')` — an asset id read out of a store that no longer had an `assets`
 * key at all. The file on disk was fine; the pointer to it was gone.
 *
 * The fix is `applyLanes`, which does a plain set. This test pins the
 * behaviour, and also pins *why*, so the next person to "optimise" it with
 * `reconcile` finds out immediately.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createStore } from 'solid-js/store'

import { applyLanes, type Lanes } from '../src/project-store.ts'
import { emptyProject, splitLinked, removeClip, type Asset, type Project } from '../src/project.ts'

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
  const edit = (lanes: Lanes) => applyLanes((value) => setProject(value), lanes, () => undefined)
  return { project, setProject, edit }
}

/** A video clip on the timeline, for seeding. */
const vclip = (id: string, out = 10) => ({ id, lane: 'video' as const, assetId: asset.id, in: 0, out })

test('an edit leaves the asset library intact', () => {
  const { project, edit } = freshStore()

  edit({ video: [vclip('a')], audio: [] })

  assert.ok(project.assets, 'project.assets must still be an object after an edit')
  assert.equal(project.assets[asset.id]?.name, 'clip.mp4')
  assert.equal(project.version, emptyProject().version)
})

test('the asset is still reachable by the id the library handed out', () => {
  // The exact expression that threw in the browser.
  const { project, edit } = freshStore()

  edit({ video: [vclip('a')], audio: [] })

  assert.equal(project.assets['ast_7fdu42uz']?.id, 'ast_7fdu42uz')
})

test('a real edit — splitting a clip — keeps the library', () => {
  const { project, edit } = freshStore()
  // Seed one clip through the same path an import would use.
  edit({ video: [vclip('a')], audio: [] })

  const split = splitLinked({ ...project, video: [...project.video] } as Project, 'video', 0, 4)
  edit({ video: split.video, audio: split.audio })

  assert.equal(project.video.length, 2, 'the split happened')
  assert.equal(project.assets[asset.id]?.name, 'clip.mp4', 'and the library survived it')
})

test('deleting a clip keeps the library', () => {
  const { project, edit } = freshStore()
  edit({ video: [vclip('a'), vclip('b')], audio: [] })

  const after = removeClip({ ...project, video: [...project.video] } as Project, 'video', 0)
  edit({ video: after.video, audio: after.audio })

  assert.equal(project.video.length, 1)
  assert.equal(project.assets[asset.id]?.name, 'clip.mp4')
})

test('the write is a plain set: no key outside the lanes is touched', () => {
  // Guards the fix directly. If someone swaps `applyLanes` for `reconcile`,
  // this fails even if the other tests happen to pass.
  const writes: unknown[] = []
  const project = { ...emptyProject(), assets: { [asset.id]: asset } }

  applyLanes(
    (lanes) => writes.push(Object.keys(lanes).sort()),
    { video: [], audio: [] },
    () => undefined,
  )

  assert.deepEqual(writes, [['audio', 'video']], 'only the two lanes are ever written')
  assert.ok(project.assets[asset.id])
})

test('the post-write hook runs after the write, not before', () => {
  // pruneSelection reads the project to see which clips still exist. If it ran
  // first it would prune against the previous project and keep dead ids.
  const order: string[] = []
  const store = { video: [], audio: [], assets: {} }

  applyLanes(
    () => {
      order.push('write')
    },
    { video: [], audio: [] },
    () => {
      order.push('prune')
      void store
    },
  )

  assert.deepEqual(order, ['write', 'prune'])
})
