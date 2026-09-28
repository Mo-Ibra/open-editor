/**
 * Format negotiation.
 *
 * The thing worth protecting is not "MP4 is first" — it is that the *whole*
 * viable list is returned, and that a user asking for something impossible
 * degrades instead of throwing.
 *
 * The failure this guards: negotiation returned only its first surviving
 * combination, so on a Linux browser (no AAC encoder) the app silently produced
 * WebM and the user had no idea MP4 had been on the table, let alone that an
 * MP4-with-audio option existed. Every social platform but YouTube and TikTok
 * rejects the result, discovered only at upload time.
 *
 * The encoder probes are stubbed, so the ordering, filtering, and fallback
 * behaviour are all testable without a browser.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

/** Codecs the pretend browser can encode. AAC is deliberately absent: that is
 *  the Linux case that made this bug invisible. */
let encodable = new Set<string>()

class FakeVideoEncoder {
  static async isConfigSupported(config: { codec: string }) {
    // Map the WebCodecs string back to mediabunny's short name.
    const short = Object.entries({
      'avc1.42001f': 'avc',
      'vp09.00.10.08': 'vp9',
      vp8: 'vp8',
    }).find(([key]) => config.codec.startsWith(key))?.[1]
    return { supported: !!short && encodable.has(short) }
  }
}
class FakeAudioEncoder {
  static async isConfigSupported(config: { codec: string }) {
    const short = { 'mp4a.40.2': 'aac', opus: 'opus', mp3: 'mp3' }[config.codec] ?? config.codec
    return { supported: encodable.has(short) }
  }
}
;(globalThis as { VideoEncoder?: unknown }).VideoEncoder = FakeVideoEncoder
;(globalThis as { AudioEncoder?: unknown }).AudioEncoder = FakeAudioEncoder

const { availablePlans, negotiate } = await import('../src/output/codecs.ts')

const OPTS = { needsAudio: true, width: 1920, height: 1080, fps: 30, bitrate: 5_000_000 }
const ids = (plans: { id: string }[]) => plans.map((p) => p.id)

test('a browser with AAC and MP3 gets both MP4 options', async () => {
  encodable = new Set(['avc', 'aac', 'mp3', 'vp9', 'opus'])
  const { plans } = await availablePlans(OPTS)
  const found = ids(plans)
  assert.ok(found.includes('mp4/avc/aac'), 'AAC MP4 is offered when it can be encoded')
  assert.ok(found.includes('mp4/avc/mp3'), 'and so is the MP3 one')
  assert.equal(found[0], 'mp4/avc/aac', 'AAC stays the default when available')
})

test('without an AAC encoder, MP4 is still available via MP3', async () => {
  // The Linux case. Before, the only MP4 row was skipped and WebM won by
  // default with no MP4-with-audio option anywhere in sight.
  encodable = new Set(['avc', 'mp3', 'vp9', 'opus'])
  const { plans } = await availablePlans(OPTS)
  const found = ids(plans)
  assert.ok(found.includes('mp4/avc/mp3'), 'MP4 + MP3 survives')
  assert.ok(!found.includes('mp4/avc/aac'), 'AAC genuinely is not offered')
  assert.equal(found[0], 'mp4/avc/mp3', 'so the default becomes MP4, not WebM')
})

test('the best available option is the default, not always MP4', async () => {
  // No H.264 encoder at all: only WebM can be produced.
  encodable = new Set(['vp9', 'opus'])
  const { plans } = await availablePlans(OPTS)
  assert.ok(ids(plans).every((id) => id.startsWith('webm')))
  assert.equal(plans[0]!.id, 'webm/vp9/opus')
  assert.equal(plans[0]!.degraded, false, 'the first option is not "degraded"')
  assert.ok(plans.slice(1).every((p) => p.degraded), 'the rest are')
})

test('silent options are hidden when the timeline has sound', async () => {
  encodable = new Set(['avc', 'aac', 'mp3', 'vp9', 'opus'])
  const { plans, notes } = await availablePlans(OPTS)
  assert.ok(!ids(plans).some((id) => id.includes('silent')))
  assert.ok(notes.some((n) => n.includes('MP4 · H.264 (no audio)')), 'and says why')
})

test('silent options are offered when the timeline has no audio', async () => {
  encodable = new Set(['avc', 'vp9'])
  const { plans } = await availablePlans({ ...OPTS, needsAudio: false })
  assert.ok(ids(plans).includes('mp4/avc/silent'))
})

test('an explicit choice is honoured', async () => {
  encodable = new Set(['avc', 'mp3', 'vp9', 'opus'])
  const plan = await negotiate(OPTS, 'mp4/avc/mp3')
  assert.equal(plan?.id, 'mp4/avc/mp3')
  assert.equal(plan?.extension, 'mp4')
  assert.equal(plan?.audio, 'mp3')
})

test('WebM can be chosen even when MP4 is available', async () => {
  encodable = new Set(['avc', 'aac', 'vp9', 'opus'])
  const plan = await negotiate(OPTS, 'webm/vp9/opus')
  assert.equal(plan?.extension, 'webm')
  assert.equal(plan?.video, 'vp9')
})

test('asking for something impossible degrades instead of throwing', async () => {
  // The dialog can offer a choice that stops being available — a 4K probe can
  // fail where 1080p passed. Throwing here would lose the whole export.
  encodable = new Set(['avc', 'mp3', 'vp9', 'opus'])
  const plan = await negotiate(OPTS, 'mp4/avc/aac')
  assert.ok(plan, 'an export still happens')
  assert.equal(plan?.id, 'mp4/avc/mp3', 'falling back to the best available')
})

test('an unknown id degrades to the default', async () => {
  encodable = new Set(['avc', 'aac'])
  const plan = await negotiate(OPTS, 'webm/vp9/opus')
  assert.equal(plan?.id, 'mp4/avc/aac')
})

test('no preference means the best available', async () => {
  encodable = new Set(['avc', 'mp3', 'vp9', 'opus'])
  const { plans } = await availablePlans(OPTS)
  const plan = await negotiate(OPTS)
  assert.equal(plan?.id, plans[0]!.id)
})

test('an impossible browser returns null rather than a broken plan', async () => {
  encodable = new Set(['h265']) // nothing we can use
  const plan = await negotiate(OPTS)
  assert.equal(plan, null)
})

test('compatibility is reported, so the UI can warn about social uploads', async () => {
  encodable = new Set(['avc', 'mp3', 'vp9', 'opus'])
  const { plans } = await availablePlans(OPTS)
  const byId = new Map(plans.map((p) => [p.id, p]))
  assert.equal(byId.get('mp4/avc/mp3')?.compatibility, 'universal')
  assert.equal(byId.get('webm/vp9/opus')?.compatibility, 'partial')
})

test('every rejection explains itself in terms a person can read', async () => {
  encodable = new Set(['avc', 'mp3', 'vp9', 'opus'])
  const { notes } = await availablePlans(OPTS)
  assert.ok(notes.length > 0, 'something was ruled out')
  for (const note of notes) {
    assert.match(note, /.+: .+/, `every note says what was ruled out and why: "${note}"`)
    assert.ok(!/undefined|NaN|\[object/.test(note), `no leaked internals: "${note}"`)
  }
  assert.ok(
    notes.some((n) => n.includes('AAC') && n.includes('encoder')),
    'the AAC rejection is stated, since that is the confusing one',
  )
})
