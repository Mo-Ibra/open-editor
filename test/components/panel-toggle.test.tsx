import { describe, expect, test } from 'vitest'
import { render } from '@solidjs/testing-library'
import { PanelToggle } from '../../src/app/view/shell/PanelToggle.tsx'

function rotation(dir: 'left' | 'right' | 'up' | 'down', collapsed: boolean): string {
  const { container } = render(() => (
    <PanelToggle panel="test" collapsed={collapsed} onToggle={() => {}} dir={dir} />
  ))
  const svg = container.querySelector('svg')
  return svg?.getAttribute('style') ?? ''
}

describe('PanelToggle', () => {
  test('points the way the panel will move', () => {
    expect(rotation('right', false)).toContain('rotate(0deg)')
    expect(rotation('right', true)).toContain('rotate(180deg)')
    expect(rotation('left', false)).toContain('rotate(180deg)')
    expect(rotation('left', true)).toContain('rotate(0deg)')
  })

  test('points up and down for the timeline panel', () => {
    expect(rotation('down', false)).toContain('rotate(90deg)')
    expect(rotation('down', true)).toContain('rotate(270deg)')
  })
})
