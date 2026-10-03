/**
 * The shared modal's two contracts: the backdrop closes it and the panel does
 * not, and focus goes in on open and comes back on close.
 *
 * The focus behaviour is the part that had no coverage anywhere else, and it is
 * invisible to a type checker.
 */

import { describe, expect, it } from 'vitest'
import { fireEvent, render } from '@solidjs/testing-library'
import { Modal, PanelHeader } from '../../src/app/view/ui/Modal.js'

describe('Modal', () => {
  it('closes on a backdrop click but not on a click inside', () => {
    let closes = 0
    const { container } = render(() => (
      <Modal onClose={() => { closes++ }} panelAttrs={{ 'data-test-panel': 'true' }}>
        <PanelHeader title="Test" />
        <div data-test-inner>body</div>
      </Modal>
    ))

    expect(container.querySelector('[data-test-panel]')).not.toBeNull()

    fireEvent.pointerDown(container.querySelector('[data-test-inner]')!)
    expect(closes).toBe(0)

    fireEvent.pointerDown(container.firstElementChild!)
    expect(closes).toBe(1)
  })

  it('takes focus on open and hands it back on close', () => {
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()

    const { unmount } = render(() => (
      <Modal onClose={() => {}}>
        <button>only</button>
      </Modal>
    ))

    expect(document.activeElement).toBe(document.querySelector('[role="dialog"]'))

    unmount()
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })
})
