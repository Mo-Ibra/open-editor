/**
 * Full screen for the picture.
 *
 * A tiny seam rather than a component detail, because three unrelated places
 * need it: the transport bar's button, the preview's context menu, and the `F`
 * shortcut. Putting the `requestFullscreen()` call inside `Preview.tsx` would
 * mean the other two could only reach it through the DOM, and a menu item that
 * has to dig for an element is a menu item that breaks silently.
 *
 * So the element is *registered* by the preview, and everyone else calls
 * `toggle()`.
 */

import { createSignal, onCleanup, type Accessor } from 'solid-js'
import { log } from '../../../dev/debug.js'

export interface Fullscreen {
  /** Whether the picture is actually full screen right now. */
  active: Accessor<boolean>
  /** Hand over the element to promote. Called by the preview on mount. */
  register: (element: HTMLElement | null) => void
  toggle: () => void
}

export function createFullscreen(onError: (message: string) => void): Fullscreen {
  const [active, setActive] = createSignal(false)
  let target: HTMLElement | null = null

  // Tracked from the event, not from the button click: the user can leave full
  // screen without going through us — Escape, or another tab taking it. A toggle
  // that drifts out of step with reality has one visible symptom, and it is a
  // button that lies.
  const onChange = (): void => {
    setActive(target !== null && document.fullscreenElement === target)
  }
  document.addEventListener('fullscreenchange', onChange)
  onCleanup(() => document.removeEventListener('fullscreenchange', onChange))

  /**
   * Hand over the element to promote.
   *
   * Called from a **ref callback**, never from `onMount`. `onMount` runs once
   * per component instance, but this element lives inside a `<Show>` that
   * unmounts it when the picture is hidden — so after hide-then-show the seam
   * still held the *destroyed* stage, and `requestFullscreen()` on an element
   * that is not in the document is refused by every browser. The user got
   * "the browser refused full screen" on a button that had worked a moment
   * earlier. A ref callback runs again for each new element, which is exactly
   * the behaviour that is needed.
   *
   * Registering `null` on teardown also stops a stale target from lingering.
   */
  function register(element: HTMLElement | null): void {
    target = element
    // Re-read the real state: leaving full screen unmounts the stage, and the
    // button must not keep claiming it is full screen.
    setActive(element !== null && document.fullscreenElement === element)
  }

  function toggle(): void {
    // Leaving is always safe when the element on screen is the one we promoted.
    // A refusal here is not the user's fault, so it is logged, not announced.
    if (target && document.fullscreenElement === target) {
      void document.exitFullscreen().catch((err: unknown) => {
        log.warn('fullscreen exit refused', String(err))
      })
      return
    }

    // Entering needs a *live* element. Hiding the picture unmounts the stage,
    // and a stale target rejects with a generic "refused" that blames the
    // user's click for what is really a missing target. Name the real reason.
    if (!target || !target.isConnected) {
      onError('Show the picture before going full screen.')
      return
    }

    // Both calls reject rather than throw synchronously, and both reject for
    // reasons the user can act on: no user gesture, or a browser that will only
    // full screen an element they interacted with. Reporting beats an
    // unhandled rejection that explains nothing.
    void target.requestFullscreen().catch((err: unknown) => {
      log.warn('fullscreen refused', String(err))
      onError('The browser refused full screen. Try clicking the picture first.')
    })
  }

  return { active, register, toggle }
}
