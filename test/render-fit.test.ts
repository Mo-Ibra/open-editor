import test from 'node:test'
import assert from 'node:assert/strict'
import { renderFrame } from '../src/render/render.ts'

type Call = { op: string; args: unknown[] }

function fakeCtx(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = []
  const record =
    (op: string) =>
    (...args: unknown[]): void => {
      calls.push({ op, args })
    }
  const ctx = {
    save: record('save'),
    restore: record('restore'),
    fillRect: record('fillRect'),
    translate: record('translate'),
    scale: record('scale'),
    drawImage: record('drawImage'),
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls }
}

function drawArgs(calls: Call[]): unknown[] {
  const draw = calls.find((c) => c.op === 'drawImage')
  assert.ok(draw, 'expected a drawImage call')
  return draw.args
}

const source = { image: {} as CanvasImageSource, width: 200, height: 100 }
const options = { width: 100, height: 100, background: '#000' }

test('renderFrame contains by default: letterboxes and never crops', () => {
  const { ctx, calls } = fakeCtx()
  renderFrame(ctx, source, {}, options)
  // min(100/200, 100/100) = 0.5 → 100x50 centred at the origin after translate.
  assert.deepEqual(drawArgs(calls), [source.image, -50, -25, 100, 50])
})

test('renderFrame cover fills the frame and crops the overflow', () => {
  const { ctx, calls } = fakeCtx()
  renderFrame(ctx, source, {}, { ...options, fit: 'cover' })
  // max(100/200, 100/100) = 1 → 200x100 centred, extending past the frame.
  assert.deepEqual(drawArgs(calls), [source.image, -100, -50, 200, 100])
})

test('renderFrame applies the clip transform about the frame centre', () => {
  const { ctx, calls } = fakeCtx()
  renderFrame(ctx, source, { transform: { scale: 2, x: 10, y: -5 } }, { ...options, fit: 'cover' })
  const translate = calls.find((c) => c.op === 'translate')
  const scale = calls.find((c) => c.op === 'scale')
  assert.deepEqual(translate?.args, [60, 45])
  assert.deepEqual(scale?.args, [2, 2])
})
