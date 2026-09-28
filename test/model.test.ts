/**
 * The editing model, including link behaviour.
 *
 * Links are the subtle part: a pair must split together, survive independent
 * deletion, and become genuinely independent when the link is broken. Each of
 * those is a promise the UI makes to the user, so each is pinned here.
 */
import assert from 'node:assert/strict'
import {
  appendAsset,
  breakLink,
  clipAtLane,
  clipDuration,
  clipEnd,
  clipOffset,
  clipStart,
  emptyProject,
  findClip,
  isLinked,
  laneDuration,
  linkedPartner,
  moveClip,
  parseProject,
  placeClip,
  projectDuration,
  removeClip,
  splitLinked,
  toFrameIndex,
  toSampleIndex,
  trimClip,
  type Asset,
  type Clip,
  type Project,
} from '../src/project.ts'

function check(name: string, fn: () => void): void {
  try {
    fn()
  } catch (err) {
    console.error(`  ✗ ${name}`)
    throw err
  }
  console.log(`  ✓ ${name}`)
}

const asset = (over: Partial<Asset> = {}): Asset => ({
  id: 'a',
  name: 'clip.mp4',
  duration: 445.72,
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
  ...over,
})

const clip = (id: string, i: number, o: number, extra: Partial<Clip> = {}): Clip => ({
  id,
  lane: 'video',
  assetId: 'a',
  in: i,
  out: o,
  ...extra,
})

const withAsset = (a = asset()): Project => ({ ...emptyProject(), assets: { [a.id]: a } })

// --- derived positions, per lane -----------------------------------------
{
  const clips = [clip('a', 0, 10), clip('b', 5, 25), clip('c', 2, 4)]
  assert.equal(clipDuration(clips[1]!), 20)
  assert.equal(clipStart(clips, 0), 0)
  assert.equal(clipStart(clips, 1), 10)
  assert.equal(clipStart(clips, 2), 30)
  assert.equal(laneDuration(clips), 32)
  assert.equal(clipAtLane(clips, 0)?.clip.id, 'a')
  assert.equal(clipAtLane(clips, 9.99)?.clip.id, 'a')
  assert.equal(clipAtLane(clips, 10)?.clip.id, 'b')
  assert.equal(clipAtLane(clips, 32), null)
}

// --- appending a file makes a LINKED PAIR --------------------------------
{
  const project = appendAsset(withAsset(), 'a', asset())
  assert.equal(project.video.length, 1, 'one video clip')
  assert.equal(project.audio.length, 1, 'one audio clip')
  assert.ok(project.video[0]!.linkId, 'the video clip is linked')
  assert.equal(project.video[0]!.linkId, project.audio[0]!.linkId, 'both halves share one link')
  assert.equal(project.video[0]!.lane, 'video')
  assert.equal(project.audio[0]!.lane, 'audio')
  assert.ok(isLinked(project, project.video[0]!), 'isLinked sees the partner')
  assert.equal(linkedPartner(project, project.audio[0]!)?.id, project.video[0]!.id)
}

// --- an audio-only file makes ONE unlinked clip --------------------------
{
  const audioOnly = asset({ id: 's', hasVideo: false, hasAudio: true })
  const project = appendAsset(withAsset(audioOnly), 's', audioOnly)
  assert.equal(project.video.length, 0, 'no video clip for an audio-only source')
  assert.equal(project.audio.length, 1)
  assert.equal(project.audio[0]!.linkId, undefined, 'nothing to link to, so it is unlinked')
  assert.equal(isLinked(project, project.audio[0]!), false)
}

// --- a silent file makes one unlinked VIDEO clip -------------------------
{
  const silent = asset({ id: 'v', hasAudio: false })
  const project = appendAsset(withAsset(silent), 'v', silent)
  assert.equal(project.video.length, 1)
  assert.equal(project.audio.length, 0)
  assert.equal(project.video[0]!.linkId, undefined, 'no audio, so no link')
}

// --- splitting a linked pair splits BOTH --------------------------------
{
  const project = appendAsset(withAsset(), 'a', asset({ duration: 20 }))
  const videoIndex = project.video.findIndex((c) => c.out - c.in === 20)
  const split = splitLinked(project, 'video', videoIndex, 7.5)

  assert.equal(split.video.length, 2, 'video split in two')
  assert.equal(split.audio.length, 2, 'the linked audio split too')

  const v = split.video
  const a = split.audio
  assert.equal(v[0]!.out, 7.5, 'left half ends at the playhead')
  assert.equal(v[1]!.in, 7.5, 'right half starts at the playhead')
  assert.equal(a[0]!.out, 7.5, 'audio left half too')
  assert.equal(a[1]!.in, 7.5, 'audio right half too')
  assert.equal(laneDuration(split.video), 20, 'total duration is conserved')
  assert.equal(laneDuration(split.audio), 20, 'audio duration is conserved')

  // The link survives the split, so further edits still pair up.
  assert.equal(v[0]!.linkId, v[1]!.linkId)
  assert.equal(a[0]!.linkId, v[0]!.linkId, 'all four still share the link')
  assert.notEqual(v[0]!.id, v[1]!.id, 'the halves are distinct clips')
}

// --- splitting an UNLINKED clip leaves its partner alone -----------------
{
  let project = appendAsset(withAsset(), 'a', asset({ duration: 20 }))
  project = breakLink(project, project.video[0]!)
  assert.equal(isLinked(project, project.video[0]!), false, 'link is broken')
  assert.equal(project.video[0]!.linkId, undefined)
  assert.equal(project.audio[0]!.linkId, undefined, 'broken on both sides')

  const split = splitLinked(project, 'video', 0, 7.5)
  assert.equal(split.video.length, 2)
  assert.equal(split.audio.length, 1, 'the audio was left alone')
  assert.equal(split.audio[0]!.out, 20, 'and is untouched')
}

// --- deleting one lane leaves the other ----------------------------------
{
  const project = appendAsset(withAsset(), 'a', asset({ duration: 20 }))
  const after = removeClip(project, 'video', 0)
  assert.equal(after.video.length, 0, 'the video is gone')
  assert.equal(after.audio.length, 1, 'the audio survives — that is the point of two lanes')
  assert.equal(laneDuration(after.audio), 20)
}

// --- a split is refused at the edges, not silently accepted --------------
{
  const project = appendAsset(withAsset(), 'a', asset({ duration: 20 }))
  assert.equal(splitLinked(project, 'video', 0, 0.01).video.length, 1, 'too close to the head')
  assert.equal(splitLinked(project, 'video', 0, 19.99).video.length, 1, 'too close to the tail')
  assert.equal(splitLinked(project, 'video', 0, -1).video.length, 1, 'before the start')
  assert.equal(splitLinked(project, 'video', 0, 50).video.length, 1, 'after the end')
  assert.equal(splitLinked(project, 'video', 0, 10).video.length, 2, 'the middle is fine')
}

// --- a linked partner too short to split does NOT get split --------------
{
  // Video is long enough to split; its linked audio has already been trimmed
  // to a sliver. Splitting must not produce a 10 ms audio clip.
  const project: Project = {
    ...withAsset(),
    video: [clip('v', 0, 20, { linkId: 'L' })],
    audio: [{ id: 'a', lane: 'audio', assetId: 'a', in: 0, out: 0.02, linkId: 'L' }],
  }
  const split = splitLinked(project, 'video', 0, 10)
  assert.equal(split.video.length, 2, 'video split')
  assert.equal(split.audio.length, 1, 'the sliver of audio is left alone rather than halved')
}

// --- a linked pair can be out of alignment, and still splits correctly ----
{
  // Audio slid 2s later than the video. Splitting at t=10 must put the audio
  // cut at 8s of source, not 10s.
  const project: Project = {
    ...withAsset(),
    video: [clip('v', 0, 20, { linkId: 'L' })],
    audio: [{ id: 'a', lane: 'audio', assetId: 'a', in: 2, out: 22, linkId: 'L' }],
  }
  const split = splitLinked(project, 'video', 0, 10)
  assert.equal(split.video[0]!.out, 10)
  // audio starts at timeline 0 but its source in-point is 2, so timeline 10
  // is source 12.
  assert.equal(split.audio[0]!.out, 12, 'the audio cut follows its own timeline, not the video source time')
  assert.equal(split.audio[1]!.in, 12)
}

// --- project duration is the longest lane -------------------------------
{
  const project: Project = {
    ...withAsset(),
    video: [clip('v', 0, 10)],
    audio: [{ id: 'a', lane: 'audio', assetId: 'a', in: 0, out: 18 }],
  }
  assert.equal(projectDuration(project), 18, 'the longer lane wins')

  const shorter: Project = {
    ...withAsset(),
    video: [clip('v', 0, 30)],
    audio: [{ id: 'a', lane: 'audio', assetId: 'a', in: 0, out: 5 }],
  }
  assert.equal(projectDuration(shorter), 30, 'video longer than audio wins')
  assert.equal(projectDuration(emptyProject()), 0)
}

// --- move and trim work per lane ----------------------------------------
{
  const project: Project = { ...withAsset(), video: [clip('a', 0, 1), clip('b', 0, 1), clip('c', 0, 1)] }
  assert.deepEqual(moveClip(project, 'video', 0, 2).video.map((c) => c.id), ['b', 'c', 'a'])
  assert.equal(moveClip(project, 'video', 0, 0), project, 'a no-op move returns the same object')
  assert.equal(moveClip(project, 'video', 0, 9), project, 'an out-of-range move is refused')

  // 0.8 - 0.2 is 0.6000000000000001 in binary floating point. The duration is
  // derived, never stored, so this is the whole story: rounding happens once,
  // at the export boundary, on integers.
  const trimmed = trimClip(project, 'video', 0, 0.2, 0.8)
  assert.ok(Math.abs(clipDuration(trimmed.video[0]!) - 0.6) < 1e-12)
  assert.equal(trimClip(project, 'video', 0, 5, 1).video[0]!.out, 5, 'out is never before in')
  assert.equal(trimClip(project, 'video', 0, -10, 1e6).video[0]!.in, 0, 'clamped to the asset')
}

// --- findClip searches both lanes ---------------------------------------
{
  const project = appendAsset(withAsset(), 'a', asset({ duration: 20 }))
  const audioClip = project.audio[0]!
  assert.equal(findClip(project, audioClip.id)?.lane, 'audio')
  assert.equal(findClip(project, 'nope'), null)
}

// --- integer boundary conversion ----------------------------------------
assert.equal(toSampleIndex(0.1, 48000), 4800)
assert.equal(toFrameIndex(1 / 30, 30), 1)

// --- parsing -------------------------------------------------------------
assert.throws(() => parseProject('{"version":1,"assets":{},"clips":[],"video":[],"audio":[]}'))
assert.throws(() => parseProject('{"version":2,"assets":{}}'), /video and an audio lane/)
assert.throws(() => parseProject('{"version":2,"assets":{},"video":[{"id":"x","assetId":"a"}],"audio":[]}'))
assert.deepEqual(parseProject('{"version":2,"assets":{},"video":[],"audio":[]}').video, [])
assert.equal(emptyProject().version, 2)

console.log('all model assertions passed')

// ---------------------------------------------------------------------------
// Gaps. `offset` is silence before a clip — an edit, not a position.
// ---------------------------------------------------------------------------

check('a gap shifts everything to its right, and position stays derived', () => {
  // A placed clip carries an offset; nothing after it stores anything.
  const placed = placeClip({ ...withAsset(), video: [clip('a', 0, 5), clip('b', 0, 5)] }, 'video', 1, 8)
  assert.equal(placed.video[1]!.offset, 3, 'three seconds of silence before it')
  assert.equal(clipStart(placed.video, 1), 8, 'and it does start at 8')
  assert.equal(clipStart(placed.video, 0), 0, 'the first clip did not move')
  assert.equal(placed.video[0]!.offset, undefined, 'nothing to its left gained an offset')
})

check('a clip may not overlap its predecessor', () => {
  const p = { ...withAsset(), video: [clip('a', 0, 5), clip('b', 0, 5)] }
  // b currently starts at 5. Asking for 3 must clamp, not overlap.
  const squeezed = placeClip(p, 'video', 1, 3)
  assert.equal(clipStart(squeezed.video, 1), 5, 'clamped to the end of the previous clip')
  assert.equal(squeezed.video[1]!.offset, 0, 'so no negative offset is stored')

  // The first clip cannot go before zero either.
  const first = placeClip(p, 'video', 0, -10)
  assert.equal(clipStart(first.video, 0), 0)
})

check('moving a clip by reorder lands it flush', () => {
  // A gap is placed deliberately; a reorder is a rearrangement, so an old
  // offset must not follow the clip into a new slot.
  let p = { ...withAsset(), video: [clip('a', 0, 3), clip('b', 0, 3), clip('c', 0, 3)] }
  p = placeClip(p, 'video', 2, 12) // leave a gap before c
  assert.equal(clipStart(p.video, 2), 12)

  const moved = moveClip(p, 'video', 2, 0)
  assert.equal(moved.video[0]!.id, 'c')
  assert.equal(moved.video[0]!.offset, 0, 'the gap did not travel with it')
  assert.equal(clipStart(moved.video, 0), 0)
  assert.equal(clipStart(moved.video, 1), 3, 'and a now follows immediately')
})

check('a gap between clips is real silence, not a shortened timeline', () => {
  const p = placeClip({ ...withAsset(), video: [clip('a', 0, 5), clip('b', 0, 5)] }, 'video', 1, 10)
  assert.equal(projectDuration(p), 15, '5 + 5 gap + 5')
  assert.equal(clipEnd(p.video, 0), 5)
  assert.equal(clipEnd(p.video, 1), 15, 'the lane ends after the gap, not at the last clip end')
  assert.equal(clipOffset(p.video[1]!), 5, 'the offset is exactly the gap: 5s clip, then 5s of silence')
  // The gap belongs to neither clip: clipAtLane finds nothing in it.
  assert.equal(clipAtLane(p.video, 7), null, 'a position inside the gap holds no clip')
  assert.equal(clipAtLane(p.video, 4)?.clip.id, 'a', 'before the gap is still the first clip')
  assert.equal(clipAtLane(p.video, 11)?.clip.id, 'b', 'after it is the second')
})

check('removing a clip takes its gap with it', () => {
  let p = { ...withAsset(), video: [clip('a', 0, 5), clip('b', 0, 5), clip('c', 0, 5)] }
  p = placeClip(p, 'video', 1, 8)
  assert.equal(projectDuration(p), 18)
  const removed = removeClip(p, 'video', 1)
  assert.equal(removed.video.length, 2)
  assert.equal(projectDuration(removed), 10, 'the gap went with the clip that owned it')
  assert.equal(clipStart(removed.video, 1), 5, 'and c is now flush after a')
})

check('splitting leaves the right half flush with the left', () => {
  let p = { ...withAsset(), video: [clip('a', 0, 10)] }
  p = placeClip(p, 'video', 0, 4) // a gap before it, which is legal
  assert.equal(clipStart(p.video, 0), 4)

  const split = splitLinked(p, 'video', 0, 4 + 3)
  assert.equal(split.video.length, 2)
  assert.equal(split.video[0]!.out, 3, 'left half, trimmed to 3s of source')
  assert.equal(clipStart(split.video, 1), 7, 'right half starts where the left ends')
  assert.equal(split.video[1]!.offset, 0, 'and carries no offset of its own')
})

check('a negative offset is normalised away on the way in', () => {
  // Defensive: the type allows it, but nothing should ever produce one.
  const p: Project = { ...withAsset(), video: [clip('a', 0, 5), { ...clip('b', 0, 5), offset: -3 }] }
  assert.equal(clipOffset(p.video[1]!), 0, 'a negative offset reads as zero')
  assert.equal(clipStart(p.video, 1), 5, 'so the clip stays flush rather than overlapping its neighbour')
})
