/**
 * A collapsed panel must offer a labelled, clickable way back.
 *
 * The bug this guards: the reopen control was a bare arrow, and the panel could
 * be collapsed but not obviously reopened. It is a source-level assertion in
 * `dom.test.ts`; this one actually clicks it.
 */

import { describe, expect, it } from 'vitest'
import { fireEvent, render } from '@solidjs/testing-library'
import { Resizer } from '../../src/app/view/Resizer.js'

describe('Resizer', () => {
  it('is a labelled, clickable tab when collapsed', () => {
    let toggles = 0
    const { container } = render(() => (
      <Resizer
        axis="x"
        at={{ left: '0px' }}
        onDrag={() => {}}
        onToggle={() => { toggles++ }}
        collapsed
        label="Media"
        title="toggle"
      />
    ))

    const tab = container.querySelector('[data-panel-tab="x"]')
    expect(tab).not.toBeNull()
    expect(tab!.textContent).toContain('Media')

    fireEvent.click(tab!)
    expect(toggles).toBe(1)
  })
})
