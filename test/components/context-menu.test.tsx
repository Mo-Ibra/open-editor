/**
 * The context menu renders its items and runs the one clicked.
 *
 * Positioning is Floating UI and not asserted here; this covers the wiring the
 * pure `menu-items` tests cannot: that the component draws the items it is
 * given and fires the row's action.
 */

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@solidjs/testing-library'
import { ContextMenu, type ContextMenuState } from '../../src/app/view/ui/ContextMenu.js'

describe('ContextMenu', () => {
  it('renders the open target’s items and runs the one clicked', () => {
    const run = vi.fn()
    const state = {
      open: () => ({ kind: 'app', x: 10, y: 10 }),
      show: () => {},
      hide: () => {},
      toggle: () => {},
    } as unknown as ContextMenuState

    const { getByText } = render(() => (
      <ContextMenu state={state} items={() => [{ label: 'Do thing', run }]} />
    ))

    fireEvent.click(getByText('Do thing'))
    expect(run).toHaveBeenCalledOnce()
  })
})
