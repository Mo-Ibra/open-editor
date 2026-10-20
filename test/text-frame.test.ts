import test from 'node:test'
import assert from 'node:assert/strict'
import { textFrameRect, type RenderText } from '../src/render/render.ts'

/** Only the parts of a 2D context that layoutText and textFrameRect touch. */
function fakeCtx(): CanvasRenderingContext2D {
  return {
    canvas: { width: 1000, height: 1000 },
    font: '',
    textBaseline: 'middle',
    textAlign: 'left',
    save: () => {},
    restore: () => {},
    measureText: (text: string) => ({ width: text.length * 10 }),
  } as unknown as CanvasRenderingContext2D
}

function layer(overrides: Partial<RenderText>): RenderText {
  return {
    text: 'Hello',
    x: 0.5,
    y: 0.5,
    align: 'center',
    font: 'sans-serif',
    weight: 700,
    italic: false,
    size: 100,
    lineHeight: 1,
    tracking: 0,
    color: '#fff',
    background: '#000',
    padding: 20,
    shadow: false,
    stroke: 0,
    strokeColor: '#000',
    opacity: 1,
    offsetY: 0,
    scale: 1,
    reveal: 1,
    ...overrides,
  }
}

test('a text frame follows the alignment and includes plate padding', () => {
  const ctx = fakeCtx()
  const right = textFrameRect(ctx, layer({ x: 0.84, align: 'right' }))
  // 5 chars × 10px = 50px text, plus 20px padding on both sides.
  assert.equal(right.width, 90)
  assert.equal(right.x, 840 - 50 - 20, 'right-aligned text ends 20px past its anchor')
  assert.equal(right.x + right.width, 840 + 20)

  const left = textFrameRect(ctx, layer({ x: 0.16, align: 'left' }))
  assert.equal(left.x, 160 - 20, 'left-aligned text starts 20px before its anchor')
  assert.equal(left.x + left.width, 160 + 50 + 20)

  const center = textFrameRect(ctx, layer({ x: 0.5, align: 'center' }))
  assert.equal(center.x, 500 - 25 - 20)
  assert.equal(center.x + center.width, 500 + 25 + 20)
})

test('the frame scales about the anchor, not the top-left corner', () => {
  const frame = textFrameRect(fakeCtx(), layer({ x: 0.84, align: 'right', scale: 2 }))
  assert.equal(frame.width, 180)
  assert.equal(frame.x, 840 - (50 + 20) * 2)
  assert.equal(frame.x + frame.width, 840 + 20 * 2)
})
