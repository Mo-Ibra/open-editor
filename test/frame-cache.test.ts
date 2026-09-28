/**
 * FrameCache is on the hot path of every scrub and every playhead move, and a
 * wrong answer is a stale frame on screen rather than an exception. Cheap to
 * test, so it is tested.
 */
import assert from 'node:assert/strict'
import { FrameCache } from '../src/media/frame-cache.ts'

// Canvas-shaped stand-ins. The cache only reads timestamp/duration and stores
// the object, so no real canvas is needed.
const frame = (timestamp: number, duration: number) =>
  ({ timestamp, duration, canvas: { width: 2, height: 2 } as unknown as HTMLCanvasElement })

const cache = new FrameCache()

// A frame covers [timestamp, timestamp + duration).
assert.equal(cache.find(0), undefined, 'empty cache finds nothing')
cache.put(frame(1, 0.5))
assert.equal(cache.find(0.99), undefined, 'a time before the frame does not hit it')
assert.ok(cache.find(1), 'the frame start is inside the frame')
assert.ok(cache.find(1.49), 'the interior is inside the frame')
assert.equal(cache.find(1.5), undefined, 'the end is exclusive')

// Non-uniform source (VFR) — a later long frame must not shadow an earlier one.
cache.clear()
cache.put(frame(0, 0.03))
cache.put(frame(0.03, 0.9))
assert.equal(cache.find(0.02)?.timestamp, 0)
assert.equal(cache.find(0.5)?.timestamp, 0.03)

// Ring buffer evicts the oldest once full, and never loses the newest.
const ring = new FrameCache()
for (let i = 0; i < FrameCache.CAPACITY; i++) ring.put(frame(i * 0.1, 0.05))
assert.equal(ring.size, FrameCache.CAPACITY, 'fills to capacity')
assert.ok(ring.find((FrameCache.CAPACITY - 1) * 0.1), 'newest frame is retained')

ring.put(frame(99, 0.05))
assert.equal(ring.size, FrameCache.CAPACITY, 'does not grow past capacity')
assert.ok(ring.find(99), 'newest frame is retained after eviction')
assert.equal(ring.find(0), undefined, 'oldest frame was evicted')

ring.clear()
assert.equal(ring.size, 0)
assert.equal(ring.find(99), undefined)

console.log('frame cache assertions passed')
