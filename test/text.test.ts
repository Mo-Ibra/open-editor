/**
 * Text overlays: the model, the render projection, and the file format.
 *
 * The renderer itself needs a canvas, but everything that decides *what* the
 * renderer is handed is pure, and that is the part that can be got wrong
 * silently: a title that animates from the wrong edge, a size that ignores the
 * export height, or a saved file that drops half of a style object.
 */

import { test } from 'node:test'
import { strict as assert } from 'node:assert'

import {
  TEXT_DURATION_DEFAULT,
  TEXT_DURATION_MIN,
  TEXT_SIZE_MAX,
  TEXT_SIZE_MIN,
  createTextClip,
  removeTextClip,
  textAt,
  textEnd,
  textFrameAt,
  textLayersAt,
  updateTextClip,
} from '../src/model/text.ts'
import { projectDuration, type Project } from '../src/model/project.ts'
import { migrateProject, serialiseProject } from '../src/app/store/project-format.ts'

test('a new title is a complete, drawable object with sane defaults', () => {
  const clip = createTextClip('t1', 2)
  assert.equal(clip.id, 't1')
  assert.equal(clip.start, 2)
  assert.equal(clip.text, 'Your text')
  assert.equal(clip.duration, TEXT_DURATION_DEFAULT)
  assert.equal(clip.x, 0.5)
  assert.equal(clip.y, 0.82)
  assert.equal(clip.animation, 'none')
  assert.equal(clip.style.font, 'sans')
  // Both fields are produced by the same model a drag feeds, so both clamp here.
  assert.equal(createTextClip('t2', -5).start, 0)
  assert.equal(createTextClip('t3', 0, { duration: 0.01 }).duration, TEXT_DURATION_MIN)
})

test('a patch changes only what it names, and merges style one field at a time', () => {
  const before = [createTextClip('a', 1), createTextClip('b', 5, { text: 'B' })]
  const after = updateTextClip(before, 'a', {
    text: 'A',
    start: -3,
    duration: 0.01,
    x: 9,
    y: -9,
    style: { color: '#ff0000', size: TEXT_SIZE_MAX * 10 },
  })

  const a = after[0]!
  assert.equal(a.text, 'A')
  assert.equal(a.start, 0, 'start cannot go negative')
  assert.equal(a.duration, TEXT_DURATION_MIN)
  assert.equal(a.x, 1, 'x is clamped to the frame')
  assert.equal(a.y, 0)
  assert.equal(a.style.color, '#ff0000', 'the patched field changed')
  assert.equal(a.style.font, 'sans', 'the untouched style fields survive the merge')
  // The other clip is returned by identity, so a re-render can skip it.
  assert.equal(after[1], before[1])

  // Size is clamped where it is *used* (the frame projection), not on write, so
  // the stored value is whatever the caller asked for.
  assert.equal(a.style.size, TEXT_SIZE_MAX * 10)
})

test('removing a title drops only that title, and textAt returns the top one', () => {
  const a = createTextClip('a', 0, { duration: 5 })
  const b = createTextClip('b', 2, { duration: 5 })
  const texts = [a, b]

  assert.equal(textAt(texts, 1)?.id, 'a')
  assert.equal(textAt(texts, 3)?.id, 'b', 'later entries draw on top and win')
  assert.equal(textAt(texts, 20), null, 'outside every span is null, not the nearest')
  assert.equal(textEnd(b), 7)

  const left = removeTextClip(texts, 'a')
  assert.deepEqual(left.map((t) => t.id), ['b'])
  assert.equal(removeTextClip(texts, 'nope').length, 2)
})

test('the frame projection is null outside the span and exact inside it', () => {
  const clip = createTextClip('t', 4, { duration: 2, animation: 'none', text: 'Hi' })
  assert.equal(textFrameAt(clip, 3.999, 1080), null)
  assert.equal(textFrameAt(clip, 6.001, 1080), null)
  assert.equal(textFrameAt(clip, 6, 1080)?.text, 'Hi', 'the last frame of the span is inside')

  const frame = textFrameAt(clip, 5, 1080)!
  assert.equal(frame.text, 'Hi')
  assert.equal(frame.x, 0.5)
  assert.equal(frame.size, clip.style.size * 1080, 'size is a fraction of the output height')
  assert.equal(frame.opacity, 1)
  assert.equal(frame.offsetY, 0)
  assert.equal(frame.scale, 1)
  assert.equal(frame.reveal, 1)
})

test('fade dips in and out, rise climbs, pop grows, typewriter reveals', () => {
  const height = 720
  const base = { start: 0, duration: 2, animationDuration: 0.5 }

  const fade = createTextClip('f', 0, { ...base, animation: 'fade' })
  assert.equal(textFrameAt(fade, 0, height)!.opacity, 0)
  assert.equal(textFrameAt(fade, 1, height)!.opacity, 1)
  assert.equal(textFrameAt(fade, 2, height)!.opacity, 0)

  const rise = createTextClip('r', 0, { ...base, animation: 'rise' })
  const early = textFrameAt(rise, 0.1, height)!
  const late = textFrameAt(rise, 0.9, height)!
  assert.ok(early.offsetY > late.offsetY, 'rise starts below and settles')
  assert.ok(early.opacity < late.opacity)

  const pop = createTextClip('p', 0, { ...base, animation: 'pop' })
  assert.ok(textFrameAt(pop, 0, height)!.scale < textFrameAt(pop, 0.5, height)!.scale)

  const type = createTextClip('w', 0, { ...base, animation: 'typewriter' })
  assert.equal(textFrameAt(type, 0, height)!.reveal, 0)
  assert.equal(textFrameAt(type, 0.25, height)!.reveal, 0.5)
  assert.equal(textFrameAt(type, 1, height)!.reveal, 1, 'the reveal caps at one')
  assert.equal(textFrameAt(type, 0.25, height)!.text, 'Your text', 'slicing is the renderer\'s job')
})

test('textLayersAt returns every visible title in draw order', () => {
  const behind = createTextClip('behind', 0, { duration: 4 })
  const front = createTextClip('front', 1, { duration: 4 })
  const layers = textLayersAt([behind, front], 2, 1080)
  assert.equal(layers.length, 2)
  assert.equal(layers[0]!.text, behind.text)
  assert.equal(layers[1]!.text, front.text)
  assert.equal(textLayersAt([behind, front], 9, 1080).length, 0)
})

test('a title past the last clip extends the project, so it can be reached', () => {
  const clips: Project = {
    version: 3,
    assets: {},
    tracks: [{ id: 'video', type: 'video', clips: [] }],
    texts: [createTextClip('t', 30, { duration: 2 })],
  }
  assert.equal(projectDuration(clips), 32)
})

test('a project with titles survives serialise then read, styles intact', () => {
  const project: Project = {
    version: 3,
    assets: {},
    tracks: [],
    texts: [
      createTextClip('t1', 1.5, {
        text: 'Hello\nworld',
        duration: 2.5,
        x: 0.2,
        y: 0.1,
        animation: 'typewriter',
        animationDuration: 1.25,
        style: { color: '#5b8cff', size: 0.14, background: '#000000', align: 'right', italic: true },
      }),
    ],
  }
  const back = migrateProject(serialiseProject(project))
  assert.deepEqual(back, project)
})

test('a title with no style block is filled from defaults on read', () => {
  const text = { id: 't', text: 'x', start: 0, duration: 1, x: 0.5, y: 0.5, animation: 'none', animationDuration: 0.6 }
  const json = JSON.stringify({ version: 3, assets: {}, tracks: [], texts: [text] })
  const back = migrateProject(json)
  assert.equal(back.texts?.[0]?.style.font, 'sans')
  assert.equal(back.texts?.[0]?.style.size > 0, true)
  // A duration below the floor is raised on read, never rendered as a sliver.
  const tiny = JSON.stringify({ version: 3, assets: {}, tracks: [], texts: [{ ...text, duration: 0 }] })
  assert.equal(migrateProject(tiny).texts?.[0]?.duration, TEXT_DURATION_MIN)
})

test('a malformed title is refused rather than rendered as garbage', () => {
  const bad = (texts: unknown): string => JSON.stringify({ version: 3, assets: {}, tracks: [], texts })
  assert.throws(() => migrateProject(bad([{ text: 'x', start: 0, duration: 1 }])), /missing its id/)
  assert.throws(() => migrateProject(bad([{ id: 't', start: 0, duration: 1 }])), /missing its text/)
  assert.throws(() => migrateProject(bad([{ id: 't', text: 'x', start: '0', duration: 1 }])), /non-numeric/)
})

test('the size bounds are ordered and leave room to be useful', () => {
  assert.ok(TEXT_SIZE_MIN > 0 && TEXT_SIZE_MIN < TEXT_SIZE_MAX)
  assert.ok(TEXT_SIZE_MAX < 1, 'a title larger than the frame is not a feature')
})
