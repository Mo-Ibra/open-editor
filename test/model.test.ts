import assert from 'node:assert/strict'
import { clipAt, clipDuration, clipStart, moveClip, projectDuration, splitClip,
         removeClip, trimClip, parseProject, emptyProject, type Clip } from '../src/project.ts'

const c = (id: string, i: number, o: number): Clip => ({ id, assetId: 'a', in: i, out: o })
const clips = [c('a', 0, 10), c('b', 5, 25), c('c', 2, 4)]

// --- derived positions (PLAN.md §3 rule 1: nothing stored) ---
assert.equal(clipDuration(clips[1]!), 20)
assert.equal(clipStart(clips, 0), 0)
assert.equal(clipStart(clips, 1), 10)
assert.equal(clipStart(clips, 2), 30)
assert.equal(projectDuration({ version: 1, assets: {}, clips }), 32) // 10 + 20 + 2

// --- lookup at boundaries ---
assert.equal(clipAt({ version: 1, assets: {}, clips }, 0)?.clip.id, 'a')
assert.equal(clipAt({ version: 1, assets: {}, clips }, 9.99)?.clip.id, 'a')
assert.equal(clipAt({ version: 1, assets: {}, clips }, 10)?.clip.id, 'b')   // exact boundary
assert.equal(clipAt({ version: 1, assets: {}, clips }, 30)?.clip.id, 'c')
assert.equal(clipAt({ version: 1, assets: {}, clips }, 31.9)?.clip.id, 'c')
assert.equal(clipAt({ version: 1, assets: {}, clips }, 32), null)             // past the end

// --- split: duration is conserved, order is preserved ---
const split = splitClip(clips, 1, 15)          // 5s into the second clip
assert.equal(split.length, 4)
// timeline 15 is 5s into a clip starting at 10, whose in-point is 5 -> source 10
assert.equal(split[1]!.out, 10)
assert.equal(split[2]!.in, 10)
assert.notEqual(split[1]!.id, split[2]!.id)
assert.equal(projectDuration({ version: 1, assets: {}, clips: split }), 32)

// --- split refuses degenerate positions (would divide by zero later) ---
assert.equal(splitClip(clips, 0, 0.01).length, 3)
assert.equal(splitClip(clips, 0, 9.99).length, 3)

// --- trim / delete / move preserve total duration ---
assert.equal(projectDuration({ version: 1, assets: {}, clips: trimClip(clips, 0, 2, 8) }), 28)
assert.equal(trimClip(clips, 0, 8, 2)[0]!.in, 8)          // guards out < in
assert.equal(projectDuration({ version: 1, assets: {}, clips: removeClip(clips, 1) }), 12)
assert.deepEqual(moveClip(clips, 0, 2).map(c => c.id), ['b', 'c', 'a'])

// --- integer boundary conversion is the whole anti-drift story ---
assert.equal(Math.round(0.1 * 48000), 4800)
assert.equal(Math.round((1 / 30) * 30), 1)

// --- parse rejects garbage rather than half-building ---
assert.throws(() => parseProject('{"version":2,"assets":{},"clips":[]}'))
assert.throws(() => parseProject('{"version":1,"assets":{}}'))
assert.throws(() => parseProject('{"version":1,"assets":{},"clips":[{"id":"x","assetId":"a"}]}'))
assert.equal(parseProject('{"version":1,"assets":{},"clips":[]}').clips.length, 0)
assert.equal(emptyProject().clips.length, 0)

console.log('all model assertions passed')
