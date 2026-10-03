/**
 * The scrub bar seeks to the clicked position.
 *
 * A minimal, direct check of the "click anywhere to jump" behaviour, which
 * depends on converting a client X into a fraction of the track's width.
 */

import { describe, expect, it } from 'vitest'
import { fireEvent, render } from '@solidjs/testing-library'
import { Scrubber } from '../../src/app/view/preview/Scrubber.js'
import type { AppState } from '../../src/app/store/state.js'

describe('Scrubber', () => {
  it('seeks to the fraction clicked', () => {
    const seeks: number[] = []
    const state = {
      duration: () => 100,
      playhead: () => 0,
      seek: (t: number) => { seeks.push(t) },
    } as unknown as AppState

    const { container } = render(() => <Scrubber state={state} />)
    const track = container.querySelector('[data-scrub]') as HTMLElement
    track.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 200, bottom: 8, width: 200, height: 8, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect

    fireEvent.pointerDown(track, { clientX: 50 })
    expect(seeks).toEqual([25])
  })
})
