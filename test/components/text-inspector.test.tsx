import { describe, expect, it } from 'vitest'
import { fireEvent, render } from '@solidjs/testing-library'

const noop = (): undefined => undefined
const g = globalThis as Record<string, unknown>
g.window ??= { addEventListener: noop, removeEventListener: noop }
g.indexedDB ??= { open: () => ({ onsuccess: noop, onerror: noop, onupgradeneeded: noop, result: {} }) }
g.IDBKeyRange ??= { bound: () => noop }
g.crypto ??= { randomUUID: () => 'x' }

const { createAppState } = await import('../../src/app/store/state.js')
const { createLayout } = await import('../../src/app/store/layout.js')
const { TextInspector } = await import('../../src/app/view/preview/TextInspector.js')
const { defaultTextStyle } = await import('../../src/model/text.js')

function mountInspector(state: ReturnType<typeof createAppState>) {
  const layout = createLayout()
  return { layout, ...render(() => <TextInspector state={state} layout={layout} />) }
}

function button(container: HTMLElement, text: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find(
    (node) => node.textContent?.trim() === text,
  )
  if (!found) throw new Error(`no button named ${text}`)
  return found as HTMLButtonElement
}

describe('the title inspector', () => {
  it('edits the title it is docked beside, without covering the picture', async () => {
    const state = createAppState()
    state.addText({ text: 'Hello', start: 0, duration: 3 })
    const { container } = mountInspector(state)

    expect(container.querySelector('[data-title-inspector]')).toBeTruthy()
    expect(container.querySelector<HTMLTextAreaElement>('[data-title-text]')?.value).toBe('Hello')

    const size = container.querySelector<HTMLInputElement>('input[aria-label="Size"]')!
    fireEvent.input(size, { target: { value: '0.12' } })
    expect(state.activeText()!.style.size).toBeCloseTo(0.12)

    const text = container.querySelector<HTMLTextAreaElement>('[data-title-text]')!
    fireEvent.input(text, { target: { value: 'Hello there' } })
    expect(state.activeText()!.text).toBe('Hello there')
  })

  it('keeps a plate translucent and can move the title to the playhead', async () => {
    const state = createAppState()
    state.addText({ start: 0, duration: 3 })
    state.seek(1)
    const { container } = mountInspector(state)

    fireEvent.click(container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Plate behind text"]')!)
    const opacity = container.querySelector<HTMLInputElement>('input[aria-label="Plate opacity"]')!
    fireEvent.input(opacity, { target: { value: '0.2' } })
    expect(state.activeText()!.style.background).toBe('rgba(0, 0, 0, 0.2)')

    fireEvent.click(button(container, 'Layout'))
    fireEvent.click(button(container, 'Start here'))
    expect(state.activeText()!.start).toBe(1)
  })

  it('applies one title’s style to every other title, and reset restores defaults', async () => {
    const state = createAppState()
    state.addText({ start: 0, duration: 3 })
    state.addText({ start: 4, duration: 3 })
    const [, second] = state.texts()
    const { container } = mountInspector(state)

    expect(second).toBeTruthy()
    fireEvent.click(container.querySelector<HTMLButtonElement>('[aria-label="Set title color to #ffd166"]')!)
    fireEvent.click(button(container, 'Apply style to all titles'))
    expect(state.texts()[0]!.style.color).toBe('#ffd166')

    fireEvent.click(container.querySelector<HTMLButtonElement>('[aria-label="Reset this title\'s look"]')!)
    expect(state.texts()[1]!.style).toEqual(defaultTextStyle())
  })

  it('closes back to the timeline', async () => {
    const state = createAppState()
    state.addText({ start: 0, duration: 3 })
    const { container } = mountInspector(state)

    fireEvent.click(container.querySelector<HTMLButtonElement>('[aria-label="Close title settings"]')!)
    expect(state.activeTextId()).toBeNull()
    expect(container.querySelector('[data-title-inspector]')).toBeNull()
  })

  it('closes on Escape from the text field', async () => {
    const state = createAppState()
    state.addText({ start: 0, duration: 3 })
    const { container } = mountInspector(state)

    const text = container.querySelector<HTMLTextAreaElement>('[data-title-text]')!
    fireEvent.keyDown(text, { key: 'Escape' })
    expect(state.activeTextId()).toBeNull()
    expect(container.querySelector('[data-title-inspector]')).toBeNull()
  })

  it('places the title at an anchor and aligns it to that side', async () => {
    const state = createAppState()
    state.addText({ start: 0, duration: 3 })
    const { container } = mountInspector(state)

    fireEvent.click(button(container, 'Layout'))
    fireEvent.click(container.querySelector<HTMLButtonElement>('[aria-label="Place title right, 84% down"]')!)
    expect(state.activeText()!.x).toBeCloseTo(0.84)
    expect(state.activeText()!.y).toBeCloseTo(0.84)
    expect(state.activeText()!.style.align).toBe('right')

    fireEvent.click(container.querySelector<HTMLButtonElement>('[aria-label="Place title left, 16% down"]')!)
    expect(state.activeText()!.x).toBeCloseTo(0.16)
    expect(state.activeText()!.y).toBeCloseTo(0.16)
    expect(state.activeText()!.style.align).toBe('left')
  })

  it('collapses to a labelled rail and expands again', async () => {
    const state = createAppState()
    state.addText({ start: 0, duration: 3 })
    const { container } = mountInspector(state)

    fireEvent.click(container.querySelector<HTMLButtonElement>('[data-panel-toggle="title"]')!)
    expect(container.querySelector('[data-title-inspector-collapsed]')).toBeTruthy()
    expect(container.querySelector('[data-title-text]')).toBeNull()

    fireEvent.click(container.querySelector<HTMLButtonElement>('[aria-label="Expand title settings"]')!)
    expect(container.querySelector('[data-title-inspector-collapsed]')).toBeNull()
    expect(container.querySelector<HTMLTextAreaElement>('[data-title-text]')).toBeTruthy()
  })

})
