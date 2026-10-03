/**
 * jsdom shims for the component tests.
 *
 * jsdom implements the DOM but not the browser APIs several components touch.
 * Each shim below exists because a component under test actually calls it; this
 * is not "polyfill everything", it is the specific surface the UI uses.
 */

import { afterEach } from 'vitest'
import { cleanup } from '@solidjs/testing-library'

// Unmount whatever the test rendered, so a component's effects and timers do
// not leak into the next test.
afterEach(() => cleanup())

// Used by Timeline and TimelineScrollbar to track panel size.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver

// jsdom has no PointerEvent; the pointer handlers read `clientX`/`buttons`, so
// a MouseEvent-based stand-in is enough.
globalThis.PointerEvent ??= MouseEvent as unknown as typeof PointerEvent
Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}

globalThis.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as unknown as typeof matchMedia

globalThis.requestAnimationFrame ??= ((cb: FrameRequestCallback) =>
  setTimeout(() => cb(performance.now()), 0)) as unknown as typeof requestAnimationFrame
globalThis.cancelAnimationFrame ??= ((id: number) => clearTimeout(id)) as unknown as typeof cancelAnimationFrame
