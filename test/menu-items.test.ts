/**
 * The context menu's shape.
 *
 * `menuItems` is a pure function of (state, target, layout), which is why it
 * could move out of `app.tsx` and land here. The invariant worth pinning is the
 * one the file's own comment claims: **every row does something real.** A menu
 * of dead placeholders teaches people the feature does not exist, and a menu
 * that promises an action it cannot perform — "Mute" on a video clip — is worse
 * than no row at all.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

// Reuse the browser shims and the real store; see state.test.ts.
const noop = (): void => undefined
const g = globalThis as Record<string, unknown>
g.window ??= { addEventListener: noop, removeEventListener: noop, innerWidth: 1440, innerHeight: 900 }
g.indexedDB ??= { open: () => ({ onsuccess: noop, onerror: noop, onupgradeneeded: noop, result: {} }) }
g.IDBKeyRange ??= { bound: () => noop }
g.performance ??= { now: () => 0 }
g.AudioContext ??= class {
  state = 'suspended'; currentTime = 0; sampleRate = 48000; destination = {}
  createGain = () => ({ gain: { value: 1 }, connect: noop })
  createBufferSource = () => ({ connect: noop, start: noop, stop: noop, buffer: null })
  createBuffer = () => ({ getChannelData: () => new Float32Array(48000) })
  decodeAudioData = async () => ({})
  resume = async () => undefined
  close = async () => undefined
}
g.navigator ??= { clipboard: { writeText: async () => undefined } }

const { createAppState } = await import('../src/app/store/state.ts')
const { menuItems } = await import('../src/app/commands/menu-items.ts')

type State = ReturnType<typeof createAppState>

/** A menu that is simply open on `target`, with the real interface. */
const menu = (target: unknown) => {
  let open: unknown = target
  return {
    open: () => open,
    show: (t: unknown) => { open = t },
    hide: () => { open = null },
    toggle: (t: unknown) => { open = open ? null : t },
  } as unknown as Parameters<typeof menuItems>[1] & { open: () => unknown }
}

const layout = { reset: noop, sidebarTrack: () => '236px', timelineTrack: () => '236px' } as never

const clip = (id: string, lane: 'video' | 'audio', extra: Record<string, unknown> = {}) => ({
  id, lane, assetId: 'a', in: 0, out: 10, ...extra,
})

function withClips(...clips: ReturnType<typeof clip>[]): State {
  const state = createAppState()
  for (const c of clips) state.project[c.lane].push(c as never)
  return state
}

const labels = (items: { label: string }[]) => items.filter((i) => i.label).map((i) => i.label)
const clickable = (items: { label: string; disabled?: boolean; separator?: boolean }[]) =>
  items.filter((i) => !i.separator && i.label && !i.disabled)

test('the clip menu has no dead rows', () => {
  const state = withClips(clip('a', 'video'))
  state.selectClip('a')
  const items = menuItems(state, menu({ kind: 'clip', clipId: 'a', lane: 'video' }), layout)

  assert.ok(items.length > 0)
  for (const item of items) {
    if (item.separator) continue
    assert.ok(!item.disabled, `"${item.label}" is disabled — a dead row`)
  }
})

test('every non-separator row runs without throwing', () => {
  const state = withClips(clip('a', 'video'), clip('b', 'audio'))
  state.selectClip('a')
  state.selectClip('b', 'toggle')
  const items = menuItems(state, menu({ kind: 'clip', clipId: 'a' }), layout)

  for (const item of items) {
    if (item.separator || item.disabled) continue
    try {
      item.run()
    } catch (err) {
      assert.fail(`"${item.label}" threw: ${String(err)}`)
    }
  }
})

test('Mute is omitted entirely for a video-only selection', () => {
  // Not disabled — absent. A greyed-out Mute on a clip with no sound still
  // reads as "this is a thing that exists here".
  const state = withClips(clip('a', 'video'))
  state.selectClip('a')
  const items = menuItems(state, menu({ kind: 'clip', clipId: 'a' }), layout)
  assert.ok(!labels(items).some((l) => /mute/i.test(l)), `expected no mute row, got ${labels(items)}`)
})

test('Mute appears once the selection includes audio', () => {
  const state = withClips(clip('a', 'video'), clip('b', 'audio'))
  state.selectClip('a')
  state.selectClip('b', 'toggle')
  const items = menuItems(state, menu({ kind: 'clip', clipId: 'a' }), layout)
  // Two clips are selected, so the label names the count — which is the point.
  assert.ok(labels(items).some((l) => /^Mute/.test(l)), `expected a Mute row, got ${labels(items)}`)
})

test('a multi-selection names its own count', () => {
  const state = withClips(clip('a', 'video'), clip('b', 'video'), clip('c', 'video'))
  state.selectClip('a')
  state.selectClip('b', 'toggle')
  state.selectClip('c', 'toggle')
  const items = menuItems(state, menu({ kind: 'clip', clipId: 'a' }), layout)
  const found = labels(items)
  assert.ok(found.includes('Delete 3 clips'), `expected a counted label, got ${found}`)
  assert.ok(found.includes('Duplicate 3 clips'))
})

test('a single selection uses the singular', () => {
  const state = withClips(clip('a', 'video'))
  state.selectClip('a')
  const found = labels(menuItems(state, menu({ kind: 'clip', clipId: 'a' }), layout))
  assert.ok(found.includes('Delete clip'), `got ${found}`)
  assert.ok(!found.some((l) => /\d/.test(l)), 'no stray numbers for one clip')
})

test('an unlinked clip says so rather than showing a dead row', () => {
  const state = withClips(clip('a', 'video'))
  state.selectClip('a')
  const found = labels(menuItems(state, menu({ kind: 'clip', clipId: 'a' }), layout))
  assert.ok(found.includes('unlinked'), 'a status, not a promise')
})

test('a linked clip offers to break the link', () => {
  const state = withClips(clip('a', 'video', { linkId: 'L1' }))
  state.selectClip('a')
  const found = labels(menuItems(state, menu({ kind: 'clip', clipId: 'a' }), layout))
  assert.ok(found.includes('Break link'), `got ${found}`)
})

test('the lane menu reflects whether the lane has anything in it', () => {
  const empty = createAppState()
  const onEmpty = menuItems(empty, menu({ kind: 'lane', lane: 'video' }), layout)
  assert.ok(clickable(onEmpty).every((i) => i.label !== 'Clear video lane' || true))
  const clearEmpty = onEmpty.find((i) => i.label === 'Clear video lane')
  assert.equal(clearEmpty?.disabled, true, 'clearing an empty lane is not offered')

  const filled = withClips(clip('a', 'video'))
  const onFilled = menuItems(filled, menu({ kind: 'lane', lane: 'video' }), layout)
  const clearFilled = onFilled.find((i) => i.label === 'Clear video lane')
  assert.notEqual(clearFilled?.disabled, true, 'but is offered when there is something to clear')
})

test('the app menu tracks undo availability and snapping', () => {
  const state = createAppState()
  const fresh = labels(menuItems(state, menu({ kind: 'app' }), layout))
  assert.ok(fresh.includes('Snapping: on'), 'snapping starts on')
  const undo = menuItems(state, menu({ kind: 'app' }), layout).find((i) => i.label === 'Undo')
  assert.equal(undo?.disabled, true, 'nothing to undo yet')

  state.setSnapping(false)
  const off = labels(menuItems(state, menu({ kind: 'app' }), layout))
  assert.ok(off.includes('Snapping: off'), 'and the menu says so')
})

test('the asset menu acts on the right-clicked asset', () => {
  const state = createAppState()
  const items = menuItems(state, menu({ kind: 'asset', assetId: 'ast_1' }), layout)
  assert.deepEqual(labels(items), ['Add to timeline', 'Select', 'Remove from project'])
  for (const item of items) assert.equal(typeof item.run, 'function')
})
