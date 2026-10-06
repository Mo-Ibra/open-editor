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
  clipAtTrack,
  clipDuration,
  clipEnd,
  clipOffset,
  clipStart,
  duplicateClips,
  emptyProject,
  findClip,
  isLinked,
  linkedPartner,
  moveClip,
  moveSelectionTo,
  parseProject,
  placeClip,
  projectDuration,
  removeClip,
  splitLinked,
  toFrameIndex,
  toSampleIndex,
  toggleMute,
  toggleHidden,
  insertClipAt,
  clearTrackRange,
  placeClipAt,
  trimClip,
  trackDuration,
  type Asset,
  type Clip,
  type Project,
} from '../src/model/project.ts'

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
  trackId: 'video',
  assetId: 'a',
  in: i,
  out: o,
  ...extra,
})

const withAsset = (a = asset()): Project => ({ ...emptyProject(), assets: { [a.id]: a } })

const videoTrack = (clips: Clip[]) => ({ id: 'video', type: 'video' as const, clips })
// The semicolon is load-bearing: without it TypeScript reads the `)` here and
// the bare `{` of the block below as an arrow's parameters and body.
const audioTrack = (clips: Clip[]) => ({ id: 'audio', type: 'audio' as const, clips });

// --- derived positions, per track -----------------------------------------
{
  const clips = [clip('a', 0, 10), clip('b', 5, 25), clip('c', 2, 4)]
  assert.equal(clipDuration(clips[1]!), 20)
  assert.equal(clipStart(clips, 0), 0)
  assert.equal(clipStart(clips, 1), 10)
  assert.equal(clipStart(clips, 2), 30)
  assert.equal(trackDuration(clips), 32)
  assert.equal(clipAtTrack(clips, 0)?.clip.id, 'a')
  assert.equal(clipAtTrack(clips, 9.99)?.clip.id, 'a')
  assert.equal(clipAtTrack(clips, 10)?.clip.id, 'b')
  assert.equal(clipAtTrack(clips, 32), null)
}

// --- appending a file makes a LINKED PAIR --------------------------------
{
  const project = appendAsset(withAsset(), 'a', asset())
  const vTrack = project.tracks.find((t) => t.type === 'video')!
  const aTrack = project.tracks.find((t) => t.type === 'audio')!
  assert.equal(vTrack.clips.length, 1, 'one video clip')
  assert.equal(aTrack.clips.length, 1, 'one audio clip')
  assert.ok(vTrack.clips[0]!.linkId, 'the video clip is linked')
  assert.equal(vTrack.clips[0]!.linkId, aTrack.clips[0]!.linkId, 'both halves share one link')
  assert.equal(vTrack.clips[0]!.trackId, 'video')
  assert.equal(aTrack.clips[0]!.trackId, 'audio')
  assert.ok(isLinked(project, vTrack.clips[0]!), 'isLinked sees the partner')
  assert.equal(linkedPartner(project, aTrack.clips[0]!)?.id, vTrack.clips[0]!.id)
}

// --- an audio-only file makes ONE unlinked clip --------------------------
{
  const audioOnly = asset({ id: 's', hasVideo: false, hasAudio: true })
  const project = appendAsset(withAsset(audioOnly), 's', audioOnly)
  const vTrack = project.tracks.find((t) => t.type === 'video')!
  const aTrack = project.tracks.find((t) => t.type === 'audio')!
  assert.equal(vTrack.clips.length, 0, 'no video clip for an audio-only source')
  assert.equal(aTrack.clips.length, 1)
  assert.equal(aTrack.clips[0]!.linkId, undefined, 'nothing to link to, so it is unlinked')
  assert.equal(isLinked(project, aTrack.clips[0]!), false)
}

// --- a silent file makes one unlinked VIDEO clip -------------------------
{
  const silent = asset({ id: 'v', hasAudio: false })
  const project = appendAsset(withAsset(silent), 'v', silent)
  const vTrack = project.tracks.find((t) => t.type === 'video')!
  const aTrack = project.tracks.find((t) => t.type === 'audio')!
  assert.equal(vTrack.clips.length, 1)
  assert.equal(aTrack.clips.length, 0)
  assert.equal(vTrack.clips[0]!.linkId, undefined, 'no audio, so no link')
}

// --- splitting a linked pair splits BOTH --------------------------------
{
  const project = appendAsset(withAsset(), 'a', asset({ duration: 20 }))
  const vTrack = project.tracks.find((t) => t.type === 'video')!
  const videoIndex = vTrack.clips.findIndex((c) => c.out - c.in === 20)
  const split = splitLinked(project, 'video', videoIndex, 7.5)

  const sv = split.tracks.find((t) => t.type === 'video')!
  const sa = split.tracks.find((t) => t.type === 'audio')!
  assert.equal(sv.clips.length, 2, 'video split in two')
  assert.equal(sa.clips.length, 2, 'the linked audio split too')

  const v = sv.clips
  const a = sa.clips
  assert.equal(v[0]!.out, 7.5, 'left half ends at the playhead')
  assert.equal(v[1]!.in, 7.5, 'right half starts at the playhead')
  assert.equal(a[0]!.out, 7.5, 'audio left half too')
  assert.equal(a[1]!.in, 7.5, 'audio right half too')
  assert.equal(trackDuration(sv.clips), 20, 'total duration is conserved')
  assert.equal(trackDuration(sa.clips), 20, 'audio duration is conserved')

  // Each side stays a *pair*, not one group of four. The left halves keep the
  // original id; the right halves get a fresh one shared between them. Letting
  // all four share one id is what broke the second split: `linkedPartner` could
  // no longer tell video-right's audio partner from video-left, returned the
  // same-track left half, and the audio was never cut again.
  assert.equal(v[0]!.linkId, a[0]!.linkId, 'the left halves are still linked to each other')
  assert.equal(v[1]!.linkId, a[1]!.linkId, 'the right halves are linked to each other')
  assert.ok(v[1]!.linkId, 'the right half is linked')
  assert.notEqual(v[1]!.linkId, v[0]!.linkId, 'the two pairs are separate link groups')
  assert.notEqual(v[0]!.id, v[1]!.id, 'the halves are distinct clips')

  // And the defining property, stated the way the UI needs it: the partner of
  // the right video half is the right audio half, not the left video half.
  assert.equal(linkedPartner(split, v[1]!)?.id, a[1]!.id, 'the right video half pairs with the right audio half')
  assert.equal(linkedPartner(split, v[0]!)?.id, a[0]!.id, 'and the left with the left')
}

// --- a linked pair survives being split more than once --------------------
{
  // The user's bug, in one sentence: "cut once, cut again, and the sound stops
  // following." Every split must leave two well-formed pairs, and the partner of
  // each right half must be its own track's right half.
  let p = appendAsset(withAsset(), 'a', asset({ duration: 20 }))
  p = splitLinked(p, 'video', 0, 7.5)
  // Split the right pair at t=12, which is 4.5s into it.
  p = splitLinked(p, 'video', 1, 12)

  const sv = p.tracks.find((t) => t.type === 'video')!
  const sa = p.tracks.find((t) => t.type === 'audio')!
  assert.equal(sv.clips.length, 3, 'video split twice')
  assert.equal(sa.clips.length, 3, 'audio split twice too, which is the whole bug')

  for (let i = 0; i < sv.clips.length; i++) {
    const v = sv.clips[i]!
    const a = sa.clips[i]!
    assert.equal(v.linkId, a.linkId, `pair ${i} shares one link`)
    assert.equal(linkedPartner(p, v)?.id, a.id, `video ${i} pairs with audio ${i}`)
    assert.equal(linkedPartner(p, a)?.id, v.id, `and it is symmetric`)
  }
  // The three pairs are three distinct groups, not one id smeared across six.
  assert.equal(new Set(sv.clips.map((c) => c.linkId)).size, 3, 'three distinct link groups')
}

// --- splitting an UNLINKED clip leaves its partner alone -----------------
{
  let project = appendAsset(withAsset(), 'a', asset({ duration: 20 }))
  const vTrack = project.tracks.find((t) => t.type === 'video')!
  project = breakLink(project, vTrack.clips[0]!)
  const bv = project.tracks.find((t) => t.type === 'video')!
  const ba = project.tracks.find((t) => t.type === 'audio')!
  assert.equal(isLinked(project, bv.clips[0]!), false, 'link is broken')
  assert.equal(bv.clips[0]!.linkId, undefined)
  assert.equal(ba.clips[0]!.linkId, undefined, 'broken on both sides')

  const split = splitLinked(project, 'video', 0, 7.5)
  const sv = split.tracks.find((t) => t.type === 'video')!
  const sa = split.tracks.find((t) => t.type === 'audio')!
  assert.equal(sv.clips.length, 2)
  assert.equal(sa.clips.length, 1, 'the audio was left alone')
  assert.equal(sa.clips[0]!.out, 20, 'and is untouched')
}

// --- deleting one track leaves the other ----------------------------------
{
  const project = appendAsset(withAsset(), 'a', asset({ duration: 20 }))
  const after = removeClip(project, 'video', 0)
  const sv = after.tracks.find((t) => t.type === 'video')!
  const sa = after.tracks.find((t) => t.type === 'audio')!
  assert.equal(sv.clips.length, 0, 'the video is gone')
  assert.equal(sa.clips.length, 1, 'the audio survives — that is the point of multiple tracks')
  assert.equal(trackDuration(sa.clips), 20)
}

// --- a split is refused at the edges, not silently accepted --------------
{
  const project = appendAsset(withAsset(), 'a', asset({ duration: 20 }))
  assert.equal(splitLinked(project, 'video', 0, 0.01).tracks.find((t) => t.type === 'video')!.clips.length, 1, 'too close to the head')
  assert.equal(splitLinked(project, 'video', 0, 19.99).tracks.find((t) => t.type === 'video')!.clips.length, 1, 'too close to the tail')
  assert.equal(splitLinked(project, 'video', 0, -1).tracks.find((t) => t.type === 'video')!.clips.length, 1, 'before the start')
  assert.equal(splitLinked(project, 'video', 0, 50).tracks.find((t) => t.type === 'video')!.clips.length, 1, 'after the end')
  assert.equal(splitLinked(project, 'video', 0, 10).tracks.find((t) => t.type === 'video')!.clips.length, 2, 'the middle is fine')
}

// --- a linked partner too short to split does NOT get split --------------
{
  // Video is long enough to split; its linked audio has already been trimmed
  // to a sliver. Splitting must not produce a 10 ms audio clip.
  const project: Project = {
    ...withAsset(),
    tracks: [
      videoTrack([clip('v', 0, 20, { linkId: 'L' })]),
      audioTrack([{ id: 'a', trackId: 'audio', assetId: 'a', in: 0, out: 0.02, linkId: 'L' }]),
    ],
  }
  const split = splitLinked(project, 'video', 0, 10)
  const sv = split.tracks.find((t) => t.type === 'video')!
  const sa = split.tracks.find((t) => t.type === 'audio')!
  assert.equal(sv.clips.length, 2, 'video split')
  assert.equal(sa.clips.length, 1, 'the sliver of audio is left alone rather than halved')
}

// --- a linked pair can be out of alignment, and still splits correctly ----
{
  // Audio slid 2s later than the video. Splitting at t=10 must put the audio
  // cut at 8s of source, not 10s.
  const project: Project = {
    ...withAsset(),
    tracks: [
      videoTrack([clip('v', 0, 20, { linkId: 'L' })]),
      audioTrack([{ id: 'a', trackId: 'audio', assetId: 'a', in: 2, out: 22, linkId: 'L' }]),
    ],
  }
  const split = splitLinked(project, 'video', 0, 10)
  const sv = split.tracks.find((t) => t.type === 'video')!
  const sa = split.tracks.find((t) => t.type === 'audio')!
  assert.equal(sv.clips[0]!.out, 10)
  // audio starts at timeline 0 but its source in-point is 2, so timeline 10
  // is source 12.
  assert.equal(sa.clips[0]!.out, 12, 'the audio cut follows its own timeline, not the video source time')
  assert.equal(sa.clips[1]!.in, 12)
}

// --- project duration is the longest track -------------------------------
{
  const project: Project = {
    ...withAsset(),
    tracks: [
      videoTrack([clip('v', 0, 10)]),
      audioTrack([{ id: 'a', trackId: 'audio', assetId: 'a', in: 0, out: 18 }]),
    ],
  }
  assert.equal(projectDuration(project), 18, 'the longer track wins')

  const shorter: Project = {
    ...withAsset(),
    tracks: [
      videoTrack([clip('v', 0, 30)]),
      audioTrack([{ id: 'a', trackId: 'audio', assetId: 'a', in: 0, out: 5 }]),
    ],
  }
  assert.equal(projectDuration(shorter), 30, 'video longer than audio wins')
  assert.equal(projectDuration(emptyProject()), 0)
}

// --- move and trim work per track ----------------------------------------
{
  const project: Project = { ...withAsset(), tracks: [videoTrack([clip('a', 0, 1), clip('b', 0, 1), clip('c', 0, 1)])] }
  assert.deepEqual(moveClip(project, 'video', 0, 2).tracks.find((t) => t.type === 'video')!.clips.map((c) => c.id), ['b', 'c', 'a'])
  assert.equal(moveClip(project, 'video', 0, 0), project, 'a no-op move returns the same object')
  assert.equal(moveClip(project, 'video', 0, 9), project, 'an out-of-range move is refused')

  // 0.8 - 0.2 is 0.6000000000000001 in binary floating point. The duration is
  // derived, never stored, so this is the whole story: rounding happens once,
  // at the export boundary, on integers.
  const trimmed = trimClip(project, 'video', 0, 0.2, 0.8)
  assert.ok(Math.abs(clipDuration(trimmed.tracks.find((t) => t.type === 'video')!.clips[0]!) - 0.6) < 1e-12)

  // Asking for out < in used to be silently "clamped" to out === in, which is a
  // zero-length clip — the state `survivorsInRange` calls corrupt. It is now
  // refused outright, so the track is handed back untouched.
  assert.equal(
    trimClip(project, 'video', 0, 5, 1),
    project,
    'a trim that would leave no clip at all is refused, not clamped into one',
  )
  assert.equal(trimClip(project, 'video', 0, -10, 1e6).tracks.find((t) => t.type === 'video')!.clips[0]!.in, 0, 'clamped to the asset')
}

// --- a trim cannot produce a clip too short to split ----------------------
{
  // The invariant: every write path refuses to create a clip shorter than
  // MIN_CLIP. `splitOne`, `splitLinked` and `survivorsInRange` each enforced it;
  // `trimClip` did not, so dragging a handle past the far edge produced a clip
  // that `clipAtTrack` can never return — invisible, unselectable by playhead,
  // unsplittable, and still shifting everything after it in the array.
  const project: Project = { ...withAsset(), tracks: [videoTrack([clip('a', 2, 12)])] } // in 2 → out 12

  const crossed = trimClip(project, 'video', 0, 2, 0.5)
  assert.equal(crossed, project, 'the out handle cannot pass the in point')
  assert.equal(clipDuration(crossed.tracks.find((t) => t.type === 'video')!.clips[0]!), 10, 'and the clip is exactly as it was')

  const crossedBack = trimClip(project, 'video', 0, 20, 12)
  assert.equal(crossedBack, project, 'nor the in handle the out point')

  // One frame either side of the limit still works, so the guard is a floor and
  // not a "trims below 40ms do nothing" cliff.
  const legal = trimClip(project, 'video', 0, 2, 2.05)
  assert.notEqual(legal, project, 'a legal trim is applied')
  assert.ok(Math.abs(clipDuration(legal.tracks.find((t) => t.type === 'video')!.clips[0]!) - 0.05) < 1e-12)

  // Growing a sliver is still allowed. An overwrite can leave a clip shorter than
  // MIN_CLIP (`survivorsInRange` cuts at the drop edges), and such a clip must
  // not be frozen — only shrinking it further is refused.
  const sliver: Project = { ...withAsset(), tracks: [videoTrack([{ ...clip('s', 0, 1), in: 0, out: 0.01 }])] }
  const grown = trimClip(sliver, 'video', 0, 0, 5)
  assert.notEqual(grown, sliver, 'a sliver can be lengthened')
  assert.equal(clipDuration(grown.tracks.find((t) => t.type === 'video')!.clips[0]!), 5)
  assert.equal(trimClip(sliver, 'video', 0, 0, 0.005), sliver, 'but not shortened further')
}

// --- a trim rolls the clip and never ripples its neighbour ----------------
{
  // A trim-in moves the LEFT edge: the start follows the new in-point and the
  // right edge holds still. Before this, `in` changed but `offset` did not, so
  // the edge could not move and the drag compounded on itself.
  const p: Project = { ...withAsset(), tracks: [videoTrack([clip('a', 0, 10), clip('b', 0, 10)])] }
  const rolled = trimClip(p, 'video', 0, 3, 10)
  const rv = rolled.tracks.find((t) => t.type === 'video')!.clips
  assert.equal(rv[0]!.in, 3, 'the source in-point moved')
  assert.equal(clipStart(rv, 0), 3, 'and the clip now starts where the edge was dragged')
  assert.equal(clipStart(rv, 0) + clipDuration(rv[0]!), 10, 'while the right edge held still')
  assert.equal(clipStart(rv, 1), 10, 'and the neighbour did not move')

  // A trim-out pins the clip after it: shortening frees a gap, it does not pull
  // B left. This is the rule `placeClip` already applies to a move.
  const shortened = trimClip(p, 'video', 0, 0, 6)
  const sv = shortened.tracks.find((t) => t.type === 'video')!.clips
  assert.equal(clipStart(sv, 0) + clipDuration(sv[0]!), 6, 'A got shorter')
  assert.equal(clipStart(sv, 1), 10, 'B did not move')
  assert.equal(clipOffset(sv[1]!), 4, 'the freed space became a gap before B')

  // Growing into the successor stops at it rather than overlapping or pushing.
  const grown = trimClip(p, 'video', 0, 0, 25)
  const gv = grown.tracks.find((t) => t.type === 'video')!.clips
  assert.equal(clipStart(gv, 0) + clipDuration(gv[0]!), 10, 'A stops at B')
  assert.equal(clipStart(gv, 1), 10, 'and B is untouched')
}

// --- a still image can be stretched to any length --------------------------
{
  const still = asset({ isImage: true, duration: 5, hasVideo: true })
  const p: Project = { ...withAsset(still), tracks: [videoTrack([clip('a', 0, 5)])] }
  const grown = trimClip(p, 'video', 0, 0, 30)
  assert.equal(clipDuration(grown.tracks[0]!.clips[0]!), 30, 'an image is not capped at its default duration')
  assert.equal(trimClip(grown, 'video', 0, 0, 5).tracks[0]!.clips[0]!.out, 5, 'and it can be shortened again')
  // A real asset is still bounded by its source length. This needs its own
  // project: `p` above deliberately holds a still, so it could never show the cap.
  const real: Project = { ...withAsset(asset({ duration: 5 })), tracks: [videoTrack([clip('a', 0, 5)])] }
  assert.equal(trimClip(real, 'video', 0, 0, 30).tracks[0]!.clips[0]!.out, 5, 'a real asset is capped at its source')
}

// --- findClip searches all tracks ---------------------------------------
{
  const project = appendAsset(withAsset(), 'a', asset({ duration: 20 }))
  const aTrack = project.tracks.find((t) => t.type === 'audio')!
  const audioClip = aTrack.clips[0]!
  assert.equal(findClip(project, audioClip.id)?.trackId, 'audio')
  assert.equal(findClip(project, 'nope'), null)
}

// --- integer boundary conversion ----------------------------------------
assert.equal(toSampleIndex(0.1, 48000), 4800)
assert.equal(toFrameIndex(1 / 30, 30), 1)

// --- parsing -------------------------------------------------------------
assert.throws(() => parseProject('{"version":1,"assets":{},"clips":[],"video":[],"audio":[]}'))
assert.throws(() => parseProject('{"version":2,"assets":{}}'), /multi-track format/)
assert.throws(() => parseProject('{"version":3,"assets":{},"tracks":[{"id":"v","type":"video","clips":[{"id":"x","assetId":"a"}]}]}'))
assert.deepEqual(parseProject('{"version":3,"assets":{},"tracks":[]}').tracks, [])
assert.equal(emptyProject().version, 3)

console.log('all model assertions passed')

// ---------------------------------------------------------------------------
// Gaps. `offset` is silence before a clip — an edit, not a position.
// ---------------------------------------------------------------------------

check('a gap shifts everything to its right, and position stays derived', () => {
  // A placed clip carries an offset; nothing after it stores anything.
  const placed = placeClip({ ...withAsset(), tracks: [videoTrack([clip('a', 0, 5), clip('b', 0, 5)])] }, 'video', 1, 8)
  const vTrack = placed.tracks.find((t) => t.type === 'video')!
  assert.equal(vTrack.clips[1]!.offset, 3, 'three seconds of silence before it')
  assert.equal(clipStart(vTrack.clips, 1), 8, 'and it does start at 8')
  assert.equal(clipStart(vTrack.clips, 0), 0, 'the first clip did not move')
  assert.equal(vTrack.clips[0]!.offset, undefined, 'nothing to its left gained an offset')
})

check('a clip that may not overlap its predecessor', () => {
  const p = { ...withAsset(), tracks: [videoTrack([clip('a', 0, 5), clip('b', 0, 5)])] }
  // b currently starts at 5. Asking for 3 must clamp, not overlap.
  const squeezed = placeClip(p, 'video', 1, 3)
  const vTrack = squeezed.tracks.find((t) => t.type === 'video')!
  assert.equal(clipStart(vTrack.clips, 1), 5, 'clamped to the end of the previous clip')
  assert.equal(vTrack.clips[1]!.offset, 0, 'so no negative offset is stored')

  // The first clip cannot go before zero either.
  const first = placeClip(p, 'video', 0, -10)
  assert.equal(clipStart(first.tracks.find((t) => t.type === 'video')!.clips, 0), 0)
})

// --- placing a clip repeatedly is what a drag does ------------------------
// A drag is not one `placeClip` call. It is one call per pointermove, each with
// a fresh absolute target, and the gesture is only smooth if the clip lands
// exactly on the target every time. The first assertion in every other
// `placeClip` test above passes either way — from a zero offset, and
// `clipStart` happens to equal `clipEnd(prev)` — which is exactly why the bug
// below survived a green suite.
check('repeated placement tracks the pointer exactly', () => {
  const base: Project = { ...withAsset(), tracks: [videoTrack([clip('a', 0, 4), clip('b', 0, 4)])] }
  let p = base

  // The gesture, as the drag controller issues it: absolute targets, 50ms apart.
  for (const target of [4.05, 4.1, 4.15, 4.2, 4.3, 5, 6, 8]) {
    p = { ...p, tracks: placeClip(p, 'video', 1, target).tracks }
    const vTrack = p.tracks.find((t) => t.type === 'video')!
    assert.ok(
      Math.abs(clipStart(vTrack.clips, 1) - target) < 1e-9,
      `asked for ${target}s, the clip is at ${clipStart(vTrack.clips, 1)}s`,
    )
  }

  // The signature of the bug: the clip never arrives. Subtract the target from
  // the position and you get half the distance asked for, again and again.
  const vTrack = p.tracks.find((t) => t.type === 'video')!
  assert.equal(clipStart(vTrack.clips, 1), 8, 'the last target, reached exactly')
})

check('a clip that already has a gap can still be moved', () => {
  // b sits behind a 2s gap, so it starts at 6. With the offset subtracted twice
  // it could not be moved at all: every call recomputed the same increment, so
  // the clip stayed exactly where it was.
  const gapped: Project = { ...withAsset(), tracks: [videoTrack([clip('a', 0, 4), clip('b', 0, 4, { offset: 2 })])] }
  assert.equal(clipStart(gapped.tracks.find((t) => t.type === 'video')!.clips, 1), 6)

  const moved = placeClip(gapped, 'video', 1, 8)
  const vTrack = moved.tracks.find((t) => t.type === 'video')!
  assert.equal(clipStart(vTrack.clips, 1), 8, 'it moved')
  assert.equal(vTrack.clips[1]!.offset, 4, 'and the offset is now the whole gap')

  // And back toward its predecessor, which is the other direction a drag goes.
  const back = placeClip(moved, 'video', 1, 4.5)
  assert.equal(clipStart(back.tracks.find((t) => t.type === 'video')!.clips, 1), 4.5, 'the gap closed to a half second')
})

check('one clip and a group of clips land in the same place', () => {
  // The two drag paths are separate functions. For a clip with nothing after it
  // they must agree exactly — a single drag and a one-clip group are the same
  // gesture and the user must not be able to tell them apart by feel. (A clip
  // with a successor deliberately differs now: a single move is local and pins
  // the successor, while a group shift ripples.)
  const targets = [4.05, 4.1, 4.2, 5, 7, 9]
  const base = (): Project => ({ ...withAsset(), tracks: [videoTrack([clip('a', 0, 4), clip('b', 0, 4), clip('c', 0, 4)])] })

  let single = base()
  for (const target of targets) single = { ...single, tracks: placeClip(single, 'video', 2, target).tracks }

  let group = base()
  const sel = new Set(['c'])
  for (const target of targets) {
    group = { ...group, tracks: moveSelectionTo(group, 'video', 2, target, sel).tracks }
  }

  const sv = single.tracks.find((t) => t.type === 'video')!
  const gv = group.tracks.find((t) => t.type === 'video')!
  assert.equal(clipStart(sv.clips, 2), targets.at(-1), 'the single drag reached the last target')
  assert.equal(clipStart(gv.clips, 2), clipStart(sv.clips, 2), 'and so did the group drag, identically')
})

check('moving a clip by reorder lands it flush', () => {
  // A gap is placed deliberately; a reorder is a rearrangement, so an old
  // offset must not follow the clip into a new slot.
  let p: Project = { ...withAsset(), tracks: [videoTrack([clip('a', 0, 3), clip('b', 0, 3), clip('c', 0, 3)])] }
  p = placeClip(p, 'video', 2, 12) // leave a gap before c
  assert.equal(clipStart(p.tracks.find((t) => t.type === 'video')!.clips, 2), 12)

  const moved = moveClip(p, 'video', 2, 0)
  const vTrack = moved.tracks.find((t) => t.type === 'video')!
  assert.equal(vTrack.clips[0]!.id, 'c')
  assert.equal(vTrack.clips[0]!.offset, 0, 'the gap did not travel with it')
  assert.equal(clipStart(vTrack.clips, 0), 0)
  assert.equal(clipStart(vTrack.clips, 1), 3, 'and a follows immediately')
})

check('a gap between clips is real silence, not a shortened timeline', () => {
  const p = placeClip({ ...withAsset(), tracks: [videoTrack([clip('a', 0, 5), clip('b', 0, 5)])] }, 'video', 1, 10)
  assert.equal(projectDuration(p), 15, '5 + 5 gap + 5')
  const vTrack = p.tracks.find((t) => t.type === 'video')!
  assert.equal(clipEnd(vTrack.clips, 0), 5)
  assert.equal(clipEnd(vTrack.clips, 1), 15, 'the track ends after the gap, not at the last clip end')
  assert.equal(clipOffset(vTrack.clips[1]!), 5, 'the offset is exactly the gap: 5s clip, then 5s of silence')
  // The gap belongs to neither clip: clipAtTrack finds nothing in it.
  assert.equal(clipAtTrack(vTrack.clips, 7), null, 'a position inside the gap holds no clip')
  assert.equal(clipAtTrack(vTrack.clips, 4)?.clip.id, 'a', 'before the gap is still the first clip')
  assert.equal(clipAtTrack(vTrack.clips, 11)?.clip.id, 'b', 'after it is the second')
})

check('removing a clip takes its gap with it', () => {
  let p: Project = { ...withAsset(), tracks: [videoTrack([clip('a', 0, 5), clip('b', 0, 5), clip('c', 0, 5)])] }
  // Move the last clip right — the only clip a move can shove freely now. The
  // gap before c belongs to c.
  p = placeClip(p, 'video', 2, 12)
  assert.equal(projectDuration(p), 17)
  const removed = removeClip(p, 'video', 2)
  assert.equal(removed.tracks.find((t) => t.type === 'video')!.clips.length, 2)
  assert.equal(projectDuration(removed), 10, 'the gap went with the clip that owned it')
  assert.equal(clipStart(removed.tracks.find((t) => t.type === 'video')!.clips, 1), 5, 'and b is still flush after a')
})

check('deleting a middle clip still ripples the track closed', () => {
  const p: Project = { ...withAsset(), tracks: [videoTrack([clip('a', 0, 5), clip('b', 0, 5), clip('c', 0, 5)])] }
  const clips = removeClip(p, 'video', 1).tracks.find((t) => t.type === 'video')!.clips
  assert.deepEqual(clips.map((c) => c.id), ['a', 'c'])
  assert.equal(clipStart(clips, 1), 5, 'c rippled left into the hole b left')
})

check('deleting the first clip leaves the rest where they are', () => {
  const p: Project = { ...withAsset(), tracks: [videoTrack([clip('a', 0, 5), clip('b', 0, 5), clip('c', 0, 5)])] }
  assert.equal(clipStart(p.tracks.find((t) => t.type === 'video')!.clips, 1), 5)
  const clips = removeClip(p, 'video', 0).tracks.find((t) => t.type === 'video')!.clips
  assert.deepEqual(clips.map((c) => c.id), ['b', 'c'])
  assert.equal(clipStart(clips, 0), 5, 'b keeps its original start; the head is left empty')
  assert.equal(clipStart(clips, 1), 10, 'and c keeps its original start too')
})

check('deleting the first clip keeps a leading gap from moving the rest', () => {
  // `-----A----------B`: a gap before A and a gap between A and B. Deleting A
  // must leave B exactly where it was, gaps and all.
  const p: Project = {
    ...withAsset(),
    tracks: [videoTrack([clip('a', 0, 5, { offset: 5 }), clip('b', 0, 5, { offset: 15 })])],
  }
  const before = p.tracks.find((t) => t.type === 'video')!.clips
  assert.equal(clipStart(before, 1), 25, 'b starts at 25 before the delete')
  const clips = removeClip(p, 'video', 0).tracks.find((t) => t.type === 'video')!.clips
  assert.deepEqual(clips.map((c) => c.id), ['b'])
  assert.equal(clipStart(clips, 0), 25, 'b does not move when the first clip is deleted')
})

check('deleting the first clip only moves its own track', () => {
  const p: Project = {
    ...withAsset(),
    tracks: [
      videoTrack([clip('v1', 0, 5), clip('v2', 0, 5)]),
      audioTrack([clip('a1', 0, 5), clip('a2', 0, 5)]),
    ],
  }
  const after = removeClip(p, 'video', 0)
  const v = after.tracks.find((t) => t.type === 'video')!.clips
  const a = after.tracks.find((t) => t.type === 'audio')!.clips
  assert.deepEqual(v.map((c) => c.id), ['v2'])
  assert.equal(clipStart(v, 0), 5, 'the video survivor holds its place')
  assert.deepEqual(a.map((c) => c.id), ['a1', 'a2'], 'the audio lane is untouched')
  assert.equal(clipStart(a, 0), 0)
})

check('deleting the last clip needs no shift', () => {
  const p: Project = { ...withAsset(), tracks: [videoTrack([clip('a', 0, 5), clip('b', 0, 5)])] }
  const clips = removeClip(p, 'video', 1).tracks.find((t) => t.type === 'video')!.clips
  assert.deepEqual(clips.map((c) => c.id), ['a'])
  assert.equal(clipStart(clips, 0), 0)
})

check('a gap after the deleted clip stops the pull', () => {
  // `A B _ C`: b is flush after a, but c already has space before it, so
  // deleting b must not drag c. The hole simply becomes part of c's gap.
  const p: Project = {
    ...withAsset(),
    tracks: [videoTrack([clip('a', 0, 5), clip('b', 0, 5), clip('c', 0, 5, { offset: 5 })])],
  }
  const before = p.tracks.find((t) => t.type === 'video')!.clips
  assert.equal(clipStart(before, 2), 15, 'c starts at 15 before the delete')
  const clips = removeClip(p, 'video', 1).tracks.find((t) => t.type === 'video')!.clips
  assert.deepEqual(clips.map((c) => c.id), ['a', 'c'])
  assert.equal(clipStart(clips, 1), 15, 'c does not move — the gap stops the ripple')
})

check('the pull stops at the first gap and leaves the rest put', () => {
  // `A B C _ D`: deleting b pulls the flush c left, but the gap before d stops
  // it there, so d keeps its absolute mark.
  const p: Project = {
    ...withAsset(),
    tracks: [
      videoTrack([
        clip('a', 0, 5),
        clip('b', 0, 5),
        clip('c', 0, 5),
        clip('d', 0, 5, { offset: 5 }),
      ]),
    ],
  }
  const before = p.tracks.find((t) => t.type === 'video')!.clips
  assert.equal(clipStart(before, 3), 20, 'd starts at 20 before the delete')
  const clips = removeClip(p, 'video', 1).tracks.find((t) => t.type === 'video')!.clips
  assert.deepEqual(clips.map((c) => c.id), ['a', 'c', 'd'])
  assert.equal(clipStart(clips, 1), 5, 'c closed the hole b left')
  assert.equal(clipStart(clips, 2), 20, 'd stayed where it was, behind the gap')
})

check('a gap that was already before the deleted clip survives', () => {
  // `A _ B C`: b has space in front of it. Deleting b pulls the flush c into
  // b's slot, but the space before b is the user's and must remain.
  const p: Project = {
    ...withAsset(),
    tracks: [videoTrack([clip('a', 0, 5), clip('b', 0, 5, { offset: 5 }), clip('c', 0, 5)])],
  }
  const before = p.tracks.find((t) => t.type === 'video')!.clips
  assert.equal(clipStart(before, 1), 10, 'b starts at 10 before the delete')
  assert.equal(clipStart(before, 2), 15, 'c is flush after b')
  const clips = removeClip(p, 'video', 1).tracks.find((t) => t.type === 'video')!.clips
  assert.deepEqual(clips.map((c) => c.id), ['a', 'c'])
  assert.equal(clipStart(clips, 1), 10, 'c moved into b slot, keeping the leading gap')
})

check('splitting leaves the right half flush with the left', () => {
  let p: Project = { ...withAsset(), tracks: [videoTrack([clip('a', 0, 10)])] }
  p = placeClip(p, 'video', 0, 4) // a gap before it, which is legal
  assert.equal(clipStart(p.tracks.find((t) => t.type === 'video')!.clips, 0), 4)

  const split = splitLinked(p, 'video', 0, 4 + 3)
  const vTrack = split.tracks.find((t) => t.type === 'video')!
  assert.equal(vTrack.clips.length, 2)
  assert.equal(vTrack.clips[0]!.out, 3, 'left half, trimmed to 3s of source')
  assert.equal(clipStart(vTrack.clips, 1), 7, 'right half starts where the left ends')
  assert.equal(vTrack.clips[1]!.offset, 0, 'and carries no offset of its own')
})

check('a negative offset is normalised away on the way in', () => {
  // Defensive: the type allows it, but nothing should ever produce one.
  const p: Project = { ...withAsset(), tracks: [videoTrack([clip('a', 0, 5), { ...clip('b', 0, 5), offset: -3 }])] }
  const vTrack = p.tracks.find((t) => t.type === 'video')!
  assert.equal(clipOffset(vTrack.clips[1]!), 0, 'a negative offset reads as zero')
  assert.equal(clipStart(vTrack.clips, 1), 5, 'so the clip stays flush rather than overlapping its neighbour')
})

// ---------------------------------------------------------------------------
// Duplicating
//
// A duplicate is only useful if the copy behaves like the original in every
// respect *except* being a separate object. The trap is links: a copy that
// keeps the original's linkId is not a copy, it is a second handle on the same
// pair, and trimming it silently trims the original.
// ---------------------------------------------------------------------------

check('duplicating a clip puts the copy directly after it', () => {
  const p: Project = { ...withAsset(), tracks: [videoTrack([clip('a', 0, 5)])] }
  const out = duplicateClips(p, ['a'])

  const vTrack = out.tracks.find((t) => t.type === 'video')!
  assert.equal(vTrack.clips.length, 2)
  assert.equal(vTrack.clips[0]!.id, 'a', 'the original stays first and untouched')
  assert.equal(vTrack.clips[1]!.in, 0)
  assert.equal(vTrack.clips[1]!.out, 5, 'the copy has the same source range')
  assert.notEqual(vTrack.clips[1]!.id, 'a', 'but it is a different clip')
  assert.equal(clipStart(vTrack.clips, 1), 5, 'the copy starts where the original ends')
})

check('duplicating a linked pair keeps the pair linked, and unlinked from the original', () => {
  const p = appendAsset(withAsset(), 'a', asset())
  const vTrack = p.tracks.find((t) => t.type === 'video')!
  const aTrack = p.tracks.find((t) => t.type === 'audio')!
  assert.equal(vTrack.clips.length, 1)
  assert.equal(aTrack.clips.length, 1)
  const originalLink = vTrack.clips[0]!.linkId
  assert.ok(originalLink, 'appendAsset makes a linked pair')

  const out = duplicateClips(p, [vTrack.clips[0]!.id, aTrack.clips[0]!.id])

  const ov = out.tracks.find((t) => t.type === 'video')!
  const oa = out.tracks.find((t) => t.type === 'audio')!
  assert.equal(ov.clips.length, 2)
  assert.equal(oa.clips.length, 2)

  const [v0, v1] = ov.clips
  const [a0, a1] = oa.clips
  assert.equal(v0!.linkId, originalLink, 'the original pair is untouched')
  assert.equal(v1!.linkId, a1!.linkId, 'the copies share one link')
  assert.notEqual(v1!.linkId, originalLink, 'and it is a different link from the original')
  assert.equal(v0!.linkId, a0!.linkId, 'the original halves still match each other')
})

check('a duplicated pair can be split without touching the original', () => {
  // The whole point of a fresh linkId: editing the copy must not reach back.
  const p = appendAsset(withAsset(), 'a', asset())
  const out = duplicateClips(p, [p.tracks.find((t) => t.type === 'video')!.clips[0]!.id, p.tracks.find((t) => t.type === 'audio')!.clips[0]!.id])

  const vTrack = out.tracks.find((t) => t.type === 'video')!
  const copyIndex = vTrack.clips.indexOf(vTrack.clips[1]!)
  // The copy sits after the original, which is a full asset long, so the split
  // point has to be measured from the copy's own start.
  const cut = clipStart(vTrack.clips, copyIndex) + 2
  const split = splitLinked(out, 'video', copyIndex, cut)
  const sv = split.tracks.find((t) => t.type === 'video')!
  const sa = split.tracks.find((t) => t.type === 'audio')!
  assert.equal(sv.clips.length, 3, 'the copy split into two')
  assert.equal(sa.clips.length, 3, 'and its partner split with it')
  assert.equal(sv.clips[0]!.out, vTrack.clips[0]!.out, 'the original is exactly as it was')
  assert.equal(sv.clips[0]!.linkId, vTrack.clips[0]!.linkId)
  assert.notEqual(sv.clips[1]!.linkId, vTrack.clips[0]!.linkId)
})

check('duplicating an unlinked clip leaves it unlinked', () => {
  const p: Project = { ...withAsset(), tracks: [audioTrack([clip('a1', 0, 5, { trackId: 'audio' })])] }
  const out = duplicateClips(p, ['a1'])
  const aTrack = out.tracks.find((t) => t.type === 'audio')!
  assert.equal(aTrack.clips.length, 2)
  assert.equal(aTrack.clips[1]!.linkId, undefined, 'no link is invented where there was none')
})

check('duplicating several clips at once copies each of them', () => {
  const p: Project = { ...withAsset(), tracks: [videoTrack([clip('a', 0, 5), clip('b', 0, 5), clip('c', 0, 5)])] }
  const out = duplicateClips(p, ['a', 'c'])
  const vTrack = out.tracks.find((t) => t.type === 'video')!
  const ids = vTrack.clips.map((c) => c.id)
  assert.equal(vTrack.clips.length, 5, 'three originals plus two copies')
  assert.deepEqual(
    ids.filter((id) => !['a', 'b', 'c'].includes(id)).length,
    2,
    'exactly two new clips',
  )
  // 'b' was not selected, so nothing was inserted next to it.
  assert.equal(vTrack.clips.filter((c) => c.id === 'b').length, 1)
})

check('duplicating nothing changes nothing', () => {
  const p: Project = { ...withAsset(), tracks: [videoTrack([clip('a', 0, 5)])] }
  assert.equal(duplicateClips(p, []), p, 'the same object, not a copy')
})

check('duplicating a clip that does not exist changes nothing', () => {
  const p: Project = { ...withAsset(), tracks: [videoTrack([clip('a', 0, 5)])] }
  assert.equal(duplicateClips(p, ['nope']), p)
})

check('a duplicate does not disturb the clips around it', () => {
  const p: Project = { ...withAsset(), tracks: [videoTrack([clip('a', 0, 5), clip('b', 0, 5)])] }
  const out = duplicateClips(p, ['a'])
  const vTrack = out.tracks.find((t) => t.type === 'video')!
  const b = vTrack.clips.find((c) => c.id === 'b')!
  // 'b' now starts after the copy instead of after 'a', which is the honest
  // consequence of inserting a clip in front of it.
  assert.equal(clipStart(vTrack.clips, vTrack.clips.indexOf(b)), 10)
  assert.equal(vTrack.clips[0]!.id, 'a')
})

// ---------------------------------------------------------------------------
// Muting is an audio-track thing
//
// `toggleMute` used to accept any clip, so a right-click on a video clip could
// set `muted` on it. Nothing then rendered that state as an error — the clip
// simply grew a mute badge and sat in the audio mixer's gain list despite
// having no sound. The flag was meaningless and visible at the same time.
// ---------------------------------------------------------------------------

check('a video clip cannot be muted', () => {
  const p: Project = { ...withAsset(), tracks: [videoTrack([clip('a', 0, 5)])] }
  const out = toggleMute(p, 'a')
  assert.equal(out.tracks.find((t) => t.type === 'video')!.clips[0]!.muted, undefined, 'no mute flag on a clip with no sound')
  assert.equal(out, p, 'and the project is returned untouched')
})

check('an audio clip can be muted, and unmuted again', () => {
  const p: Project = { ...withAsset(), tracks: [audioTrack([clip('a', 0, 5, { trackId: 'audio' })])] }

  const muted = toggleMute(p, 'a')
  assert.equal(muted.tracks.find((t) => t.type === 'audio')!.clips[0]!.muted, true)

  const unmuted = toggleMute(muted, 'a')
  assert.equal(unmuted.tracks.find((t) => t.type === 'audio')!.clips[0]!.muted, false)
})

check('muting an audio clip leaves the video track alone', () => {
  const p = appendAsset(withAsset(), 'a', asset())
  const out = toggleMute(p, p.tracks.find((t) => t.type === 'audio')!.clips[0]!.id)
  const aTrack = out.tracks.find((t) => t.type === 'audio')!
  const vTrack = out.tracks.find((t) => t.type === 'video')!
  assert.equal(aTrack.clips[0]!.muted, true)
  assert.equal(vTrack.clips[0]!.muted, undefined, 'the picture half is untouched')
  assert.equal(vTrack.clips[0]!.linkId, p.tracks.find((t) => t.type === 'video')!.clips[0]!.linkId, 'and still linked')
})

check('muting a clip that does not exist changes nothing', () => {
  const p: Project = { ...withAsset(), tracks: [audioTrack([clip('a', 0, 5, { trackId: 'audio' })])] }
  assert.equal(toggleMute(p, 'nope'), p)
})


// ---------------------------------------------------------------------------
// `toggleHidden` — the video counterpart of `toggleMute`
//
// Same reasoning as mute, but the stakes are higher: a `hidden` flag that
// reached the exporter would write a black run into somebody's file. The two
// flags are kept separate so neither track can hold the other's state.
// ---------------------------------------------------------------------------

check('a video clip can be hidden and shown again', () => {
  const p = { ...withAsset(), tracks: [videoTrack([clip('v1', 0, 5)])] }
  const hidden = toggleHidden(p, 'v1')
  assert.equal(hidden.tracks.find((t) => t.type === 'video')!.clips[0]!.hidden, true)
  assert.equal(toggleHidden(hidden, 'v1').tracks.find((t) => t.type === 'video')!.clips[0]!.hidden, false, 'and it toggles back')
})

check('hiding is not removing: the clip keeps its place and its link', () => {
  const p = { ...withAsset(), tracks: [videoTrack([clip('v1', 0, 5, { linkId: 'L1' }), clip('v2', 5, 10)])] }
  const hidden = toggleHidden(p, 'v1')
  const vTrack = hidden.tracks.find((t) => t.type === 'video')!
  assert.equal(vTrack.clips.length, 2, 'the clip is still on the timeline')
  assert.equal(vTrack.clips[0]!.id, 'v1', 'and in the same track position')
  assert.equal(vTrack.clips[0]!.linkId, 'L1', 'and still linked, so edits stay together')
})

check('an audio clip cannot be hidden', () => {
  // The mirror of the mute rule. A `hidden` flag on a clip with no picture
  // would be a second way to say "muted", and two ways to say one thing is how
  // they drift apart.
  const p = { ...withAsset(), tracks: [audioTrack([clip('a1', 0, 5, { trackId: 'audio' })])] }
  const out = toggleHidden(p, 'a1')
  assert.equal(out.tracks.find((t) => t.type === 'audio')!.clips[0]!.hidden, undefined, 'no hide flag on a clip with no picture')
  assert.equal(out, p, 'and the project is returned untouched')
})

check('a video clip cannot be muted, and an audio clip cannot be hidden', () => {
  // The two flags must never be interchangeable, or a caller could silence a
  // video clip's audio by "hiding" it.
  const p = { ...withAsset(), tracks: [videoTrack([clip('v1', 0, 5)]), audioTrack([clip('a1', 0, 5, { trackId: 'audio' })])] }
  assert.equal(toggleMute(p, 'v1').tracks.find((t) => t.type === 'video')!.clips[0]!.muted, undefined)
  assert.equal(toggleMute(p, 'a1').tracks.find((t) => t.type === 'audio')!.clips[0]!.muted, true)
  const q = toggleHidden(p, 'v1')
  assert.equal(q.tracks.find((t) => t.type === 'video')!.clips[0]!.hidden, true)
  assert.equal(toggleHidden(q, 'a1').tracks.find((t) => t.type === 'audio')!.clips[0]!.hidden, undefined, 'hiding audio is a no-op')
})


// ---------------------------------------------------------------------------
// Dropping anywhere
//
// A drop used to append to the end of a track and clamp, so letting go in the
// middle of the edit did nothing recognisable. These pin the three cases a user
// can actually aim at: a gap, the middle of a clip, and past the end.
// ---------------------------------------------------------------------------

const vid = (id: string, i: number, o: number, over: Partial<Clip> = {}): Clip => ({
  id, trackId: 'video', assetId: 'a', in: i, out: o, ...over,
})

const startsOf = (p: Project): number[] => {
  const vTrack = p.tracks.find((t) => t.type === 'video')!
  return vTrack.clips.map((_, i) => Math.round(clipStart(vTrack.clips, i) * 1000) / 1000)
}

check('a drop into a gap leaves the gap and lands where it was aimed', () => {
  // a: 0–5, then a 2s gap, then b: 7–9
  const p: Project = { ...withAsset(), tracks: [videoTrack([vid('a', 0, 5), vid('b', 5, 7, { offset: 2 })])] }
  assert.deepEqual(startsOf(p), [0, 7], 'the gap is there before the drop')

  const out = insertClipAt(p, 'video', 5, vid('n', 0, 2))
  assert.deepEqual(startsOf(out), [0, 5, 9], 'inserted at 5, and b pushed from 7 to 9')
  assert.equal(out.tracks.find((t) => t.type === 'video')!.clips.length, 3)
  assert.equal(out.tracks.find((t) => t.type === 'video')!.clips[2]!.id, 'b', 'b is still b — it moved, it was not rebuilt')
})

check('a drop inside a clip splits it and keeps the tail', () => {
  const p: Project = { ...withAsset(), tracks: [videoTrack([vid('a', 0, 10), vid('b', 0, 2)])] }
  const out = insertClipAt(p, 'video', 4, vid('n', 0, 1))

  // a becomes two halves, so 2 clips in and 4 out: head, new, tail, then b.
  const vTrack = out.tracks.find((t) => t.type === 'video')!
  assert.equal(vTrack.clips.length, 4)
  assert.deepEqual(startsOf(out), [0, 4, 5, 11], 'head 0–4, new 4–5, tail 5–11 (6s of source), b at 11')
  assert.equal(vTrack.clips[0]!.id, 'a', 'the head is still a')
  assert.equal(vTrack.clips[3]!.id, 'b', 'and b was pushed along, not eaten')
  assert.notEqual(vTrack.clips[2]!.id, 'a', 'the tail is a new clip with its own id')
  assert.equal(vTrack.clips[2]!.in, 4, 'the tail starts at source time 4, so no footage is lost or repeated')
  assert.equal(vTrack.clips[1]!.id, 'n', 'the new clip sits between the two halves')
})

check('a drop past the end appends with a gap', () => {
  const p: Project = { ...withAsset(), tracks: [videoTrack([vid('a', 0, 5)])] }
  const out = insertClipAt(p, 'video', 12, vid('n', 0, 2))
  assert.deepEqual(startsOf(out), [0, 12])
  assert.equal(Math.round(clipEnd(out.tracks.find((t) => t.type === 'video')!.clips, 1) * 1000) / 1000, 14, 'and it is 2s long')
})

check('a drop at exactly a clip edge does not make a zero-length fragment', () => {
  const p: Project = { ...withAsset(), tracks: [videoTrack([vid('a', 0, 5), vid('b', 0, 2)])] }
  const out = insertClipAt(p, 'video', 5, vid('n', 0, 1))
  assert.equal(out.tracks.find((t) => t.type === 'video')!.clips.length, 3, 'inserted between them, not splitting either')
  assert.equal(out.tracks.find((t) => t.type === 'video')!.clips.every((c) => clipDuration(c) > 0), true, 'no zero-length clip')
})

// --- overwrite --------------------------------------------------------------

check('overwriting the middle of a clip keeps its head and tail', () => {
  const p: Project = { ...withAsset(), tracks: [videoTrack([vid('a', 0, 10), vid('b', 0, 2)])] }
  const out = placeClipAt(p, 'video', 4, vid('n', 0, 2), 'overwrite')

  // The drop straddles nothing, but `a` spans both edges of the 4–6 window, so
  // it becomes a head and a tail. Four clips out, not three.
  // The tail is a *new* clip, so it gets a fresh id — a new identity is what
  // lets it be selected and trimmed without dragging the head along.
  const vTrack = out.tracks.find((t) => t.type === 'video')!
  assert.equal(vTrack.clips.length, 4)
  assert.deepEqual([vTrack.clips[0]!.id, vTrack.clips[1]!.id, vTrack.clips[3]!.id], ['a', 'n', 'b'])
  assert.equal(vTrack.clips[2]!.id.startsWith('clp'), true, 'the tail has a generated id')
  assert.equal(vTrack.clips[2]!.id === 'a', false, 'and is not the head')
  assert.deepEqual(startsOf(out), [0, 4, 6, 10], 'head 0–4, new 4–6, tail 6–10, b still at 10')
  assert.equal(vTrack.clips[0]!.out, 4, "a's head is trimmed to the drop point")
  assert.equal(vTrack.clips[2]!.in, 6, "and its tail resumes at source 6, so no footage is lost")
  assert.equal(vTrack.clips[3]!.id, 'b', 'b kept its identity, and its start time, exactly')
})

check('a clip wholly under a drop is removed, and one only partly is trimmed', () => {
  // a: 0–2, b: 2–4, c: 4–6. Dropping 4s at t=1 covers 1–5.
  const p: Project = { ...withAsset(), tracks: [videoTrack([vid('a', 0, 2), vid('b', 0, 2), vid('c', 0, 2)])] }
  const out = placeClipAt(p, 'video', 1, vid('n', 0, 4), 'overwrite')

  // a loses its second half, b is entirely covered, c loses its first second.
  assert.deepEqual(startsOf(out), [0, 1, 5], "a trimmed to 0–1, n at 1–5, c's tail at 5")
  const vTrack = out.tracks.find((t) => t.type === 'video')!
  assert.equal(vTrack.clips.some((c) => c.id === 'b'), false, 'b was wholly under the drop, so it is gone')
  assert.equal(vTrack.clips.at(-1)!.in, 1, "c's surviving second is at source 1, not re-read from 0")
  assert.equal(
    vTrack.clips.every((c) => clipDuration(c) > 0),
    true,
    'and no zero-length clip was left behind — out < in is a corrupt clip',
  )
})

check('clearing a span on its own keeps the gaps outside it', () => {
  const p: Project = { ...withAsset(), tracks: [videoTrack([vid('a', 0, 2), vid('b', 0, 2, { offset: 3 })])] }
  // a 0–2, gap, b 5–7. Clear 1–2 (the end of a).
  const out = clearTrackRange(p, 'video', 1, 2)
  assert.deepEqual(startsOf(out), [0, 5], "a's head keeps its place and b does not slide left")
  assert.equal(out.tracks.find((t) => t.type === 'video')!.clips[0]!.out, 1, 'a was trimmed to the clear point')
})

check('insert mode never destroys anything', () => {
  const p: Project = { ...withAsset(), tracks: [videoTrack([vid('a', 0, 10), vid('b', 0, 2)])] }
  const out = placeClipAt(p, 'video', 4, vid('n', 0, 1), 'insert')

  // The invariant worth pinning is the *footage*, not the clip count: a split
  // legitimately turns one clip into two, so counting clips proves nothing.
  // Every second of source that was there before is still there after, plus the
  // new clip's second.
  const footage = (clips: Clip[]): number => Math.round(clips.reduce((n, c) => n + clipDuration(c), 0) * 1000) / 1000
  const ov = out.tracks.find((t) => t.type === 'video')!
  const pv = p.tracks.find((t) => t.type === 'video')!
  assert.equal(footage(ov.clips), footage(pv.clips) + 1, 'no source footage lost, none gained')
  assert.equal(ov.clips.some((c) => c.id === 'n'), true, 'and the new clip is there')
  // Everything after the drop moved right, which is the whole of insert mode.
  assert.equal(clipStart(ov.clips, ov.clips.length - 1) > clipStart(pv.clips, 1), true, 'b was pushed along')
})

check('a drop at zero is not negative', () => {
  const p: Project = { ...withAsset(), tracks: [videoTrack([vid('a', 0, 5, { offset: 3 })])] }
  const out = insertClipAt(p, 'video', -5, vid('n', 0, 1))
  assert.equal(startsOf(out)[0], 0, 'a clip can never start before the timeline')
  assert.equal(out.tracks.find((t) => t.type === 'video')!.clips[0]!.offset, 0)
})

// --- a drop lands where it was aimed ----------------------------------------

check('an insert drop lands where it was aimed, not at the far end of the clip', () => {
  // The bug: a drop within MIN_CLIP of a clip's edge cannot be split, so the clip
  // was inserted *after* the one it landed on. Aim at 0.01s, get 10s, with nothing
  // on screen to explain it.
  const base = (o: number): Project => ({ ...withAsset(), tracks: [videoTrack([clip('a', 0, o)])] })
  const landedAt = (p: Project): number => {
    const vTrack = p.tracks.find((t) => t.type === 'video')!
    const i = vTrack.clips.findIndex((c) => c.id === 'n')
    return i < 0 ? NaN : clipStart(vTrack.clips, i)
  }

  // Inside, well clear of both ends: exact.
  assert.ok(Math.abs(landedAt(insertClipAt(base(10), 'video', 2, clip('n', 0, 1))) - 2) < 1e-9)

  // Within MIN_CLIP of the start: in front of the clip, flush. The old answer put
  // it at the clip's *end*.
  assert.ok(Math.abs(landedAt(insertClipAt(base(10), 'video', 0.01, clip('n', 0, 1))) - 0) <= 0.04,
    'a hair inside the start goes in front, not to the far end')
  assert.equal(landedAt(insertClipAt(base(10), 'video', 0, clip('n', 0, 1))), 0, 'and exactly at the start')

  // Within MIN_CLIP of the end: also flush, and it must not leave a stub.
  assert.ok(Math.abs(landedAt(insertClipAt(base(10), 'video', 9.99, clip('n', 0, 1))) - 9.99) <= 0.04,
    'a hair inside the end stays near the end')

  // In a gap, and past the end: unchanged behaviour.
  assert.equal(landedAt(insertClipAt(base(10), 'video', 12, clip('n', 0, 1))), 12, 'past the end')
})

check('no drop can leave a clip shorter than MIN_CLIP', () => {
  // The invariant the whole branch exists to protect. Swept across a 10s clip at
  // 5ms resolution, so it covers the neighbourhood of both edges where the answer
  // used to change discontinuously.
  const p0: Project = { ...withAsset(), tracks: [videoTrack([clip('a', 0, 10)])] }
  let worst = Infinity
  let worstAt = 0
  for (let k = 0; k <= 2000; k++) {
    const t = (k / 2000) * 10
    for (const c of insertClipAt(p0, 'video', t, clip('n', 0, 1)).tracks.find((t) => t.type === 'video')!.clips) {
      const d = clipDuration(c)
      if (d < worst) { worst = d; worstAt = t }
    }
  }
  // Within float noise: the shortfall is ~1e-15, one part in 10^16.
  assert.ok(worst >= 0.04 - 1e-9, `a drop at ${worstAt}s left a ${worst}s fragment`)
})

check('a drop at a clip boundary does not split it', () => {
  // Already covered for the start; this is the boundary *between* two clips,
  // where the old code refused the split and appended after the second one.
  const p: Project = { ...withAsset(), tracks: [videoTrack([clip('a', 0, 5), clip('b', 0, 2)])] }
  const out = insertClipAt(p, 'video', 5, clip('n', 0, 1))
  assert.equal(out.tracks.find((t) => t.type === 'video')!.clips.length, 3, 'three clips, not four: nothing was split')
  assert.deepEqual(out.tracks.find((t) => t.type === 'video')!.clips.map((c) => c.id), ['a', 'n', 'b'], 'and it went between them')
  assert.equal(clipStart(out.tracks.find((t) => t.type === 'video')!.clips, 1), 5, 'at the boundary, not after b')
})
