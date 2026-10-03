/**
 * The timeline's horizontal scrollbar.
 *
 * The native one lived inside the scroller: it only appeared once the content
 * overflowed, it was a thin dark strip at the very bottom, and reaching the end
 * of a long edit meant scrolling or zooming out first. This is a permanent
 * control with a large hit area — click anywhere on the track to jump, drag the
 * thumb to pan — so "go to the end" is one gesture.
 *
 * **It measures the content from `contentWidth`, not `scrollWidth`.** Reading
 * the scroller's `scrollWidth` gave the wrong answer (it never grew past the
 * viewport), so the thumb sat at 100% no matter how far the timeline ran. The
 * track's width is the authority, and it is already reactive.
 */

import { createEffect, createSignal, onCleanup, onMount } from 'solid-js'

export function TimelineScrollbar(props: {
  scroller: () => HTMLDivElement | undefined
  /** The full track width in pixels — the authority on how much there is. */
  contentWidth: () => number
}) {
  let track!: HTMLDivElement
  const [scrollLeft, setScrollLeft] = createSignal(0)
  const [clientWidth, setClientWidth] = createSignal(0)
  const [dragging, setDragging] = createSignal(false)

  /** How much timeline there is, never less than the window onto it. */
  const total = (): number => Math.max(props.contentWidth(), clientWidth())
  const maxScroll = (): number => Math.max(0, total() - clientWidth())
  const visible = (): number => (total() > 0 ? Math.min(1, clientWidth() / total()) : 1)

  function measure(): void {
    const el = props.scroller()
    if (!el) return
    // `clientWidth` is 0 for an element that has not laid out yet; fall back to
    // the rect so the bar is not briefly full-width on first paint.
    const width = el.clientWidth || el.getBoundingClientRect().width
    setClientWidth(Math.round(width))
    setScrollLeft(el.scrollLeft)
  }

  onMount(() => {
    const el = props.scroller()
    if (!el) return
    const onScroll = (): void => {
      setScrollLeft(el.scrollLeft)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    measure()
    // Again after the first layout, for the case where `onMount` ran before it.
    const raf = requestAnimationFrame(measure)
    onCleanup(() => {
      el.removeEventListener('scroll', onScroll)
      observer.disconnect()
      cancelAnimationFrame(raf)
    })
  })

  // Zoom and timeline length change the content; re-measure after the track has
  // been resized.
  createEffect(() => {
    props.contentWidth()
    const raf = requestAnimationFrame(measure)
    onCleanup(() => cancelAnimationFrame(raf))
  })

  const thumbPercent = (): number => visible() * 100
  const thumbLeft = (): number => {
    const max = maxScroll()
    if (max <= 0) return 0
    return (scrollLeft() / max) * (100 - thumbPercent())
  }

  function jumpTo(clientX: number): void {
    const el = props.scroller()
    if (!el || maxScroll() <= 0) return
    const rect = track.getBoundingClientRect()
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    el.scrollLeft = frac * maxScroll()
  }

  let startX = 0
  let startScroll = 0

  function onThumbDown(event: PointerEvent): void {
    event.stopPropagation()
    const el = props.scroller()
    if (!el || maxScroll() <= 0) return
    setDragging(true)
    startX = event.clientX
    startScroll = el.scrollLeft
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  }

  function onThumbMove(event: PointerEvent): void {
    if (!dragging()) return
    const el = props.scroller()
    if (!el) return
    const trackWidth = track.getBoundingClientRect().width
    const thumbWidth = (thumbPercent() / 100) * trackWidth
    const usable = Math.max(1, trackWidth - thumbWidth)
    el.scrollLeft = Math.max(0, Math.min(maxScroll(), startScroll + (event.clientX - startX) * (maxScroll() / usable)))
  }

  return (
    <div
      ref={track}
      class="group relative h-3.5 shrink-0 cursor-pointer border-t border-line-soft bg-panel"
      onPointerDown={(e) => jumpTo(e.clientX)}
      aria-label="Timeline scroll"
      role="scrollbar"
      aria-orientation="horizontal"
      aria-controls="timeline-track"
      aria-valuemin={0}
      aria-valuemax={Math.round(maxScroll())}
      aria-valuenow={Math.round(scrollLeft())}
    >
      <div
        class="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full transition-colors"
        classList={{
          'bg-accent': dragging(),
          'bg-line-strong group-hover:bg-[#3a3d4a]': !dragging(),
        }}
        style={{ left: `${thumbLeft()}%`, width: `${Math.max(3, thumbPercent())}%` }}
        onPointerDown={onThumbDown}
        onPointerMove={onThumbMove}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
      />
    </div>
  )
}
