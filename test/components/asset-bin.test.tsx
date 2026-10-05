/**
 * The media bin: filtering, and removing.
 *
 * The store-level test already proves `removeAsset` deletes the asset from the
 * project; this proves the *row* reacts — the bug where the file stayed listed
 * after being removed lived in the wiring between the two, not either end.
 */

import { describe, expect, it } from 'vitest'
import { fireEvent, render } from '@solidjs/testing-library'
import { createSignal } from 'solid-js'
import { AssetBin } from '../../src/app/view/media/AssetBin.js'
import type { Asset } from '../../src/model/project.js'
import type { AppState } from '../../src/app/store/state.js'
import type { ContextMenuState } from '../../src/app/view/ui/ContextMenu.js'
import type { LayoutState } from '../../src/app/store/layout.js'

const asset = (id: string, name: string, extra: Partial<Asset> = {}): Asset => ({
  id, name, duration: 4, width: 1280, height: 720, rotation: 0, frameRate: 30,
  variableFrameRate: false, hasVideo: true, hasAudio: false, audioSampleRate: 48000,
  audioChannels: 2, videoCodec: 'avc', audioCodec: null, size: 1000, ...extra,
})

function fakeState(assets: Asset[]) {
  const [selectedAsset, setSelectedAsset] = createSignal<string | null>(null)
  const removed: string[] = []
  const state = {
    assetIds: () => assets.map((a) => a.id),
    getAsset: (id: string) => assets.find((a) => a.id === id),
    entryFor: (id: string) => (assets.some((a) => a.id === id) ? { asset } : undefined),
    selectedAsset,
    setSelectedAsset,
    addAssetToTimeline: () => {},
    removeAsset: (id: string) => { removed.push(id) },
    loading: () => false,
    addFiles: async () => {},
    library: { get: () => undefined },
  }
  return { state, removed }
}

const menu = { open: () => null, show: () => {}, hide: () => {}, toggle: () => {} } as unknown as ContextMenuState
const layout = { sidebarCollapsed: () => false, toggleSidebar: () => {} } as unknown as LayoutState

describe('AssetBin', () => {
  it('filters by name and removes the clicked file from the project', () => {
    const { state, removed } = fakeState([asset('a1', 'beach.mp4'), asset('a2', 'studio.mp4')])
    const { container } = render(() => (
      <AssetBin state={state as unknown as AppState} menu={menu} layout={layout} />
    ))

    expect(container.textContent).toContain('beach.mp4')
    expect(container.textContent).toContain('studio.mp4')

    const search = container.querySelector('input[type="search"]')!
    fireEvent.input(search, { target: { value: 'stud' } })
    expect(container.textContent).toContain('studio.mp4')
    expect(container.textContent).not.toContain('beach.mp4')

    fireEvent.click(container.querySelector('[aria-label="Remove from the project"]')!)
    expect(removed).toEqual(['a2'])
  })

  it('puts each file in exactly one kind: a talking-head is video, not audio', () => {
    const { state } = fakeState([
      asset('v1', 'talk.mp4', { hasVideo: true, hasAudio: true }),
      asset('v2', 'silent.mp4', { hasVideo: true, hasAudio: false }),
      asset('a1', 'music.mp3', { hasVideo: false, hasAudio: true, width: 0, height: 0 }),
      asset('i1', 'logo.png', { isImage: true, hasAudio: false }),
    ])
    const { container } = render(() => (
      <AssetBin state={state as unknown as AppState} menu={menu} layout={layout} />
    ))
    const text = (): string => container.textContent ?? ''
    const tab = (label: string): Element =>
      [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!

    fireEvent.click(tab('video'))
    expect(text()).toContain('talk.mp4')
    expect(text()).toContain('silent.mp4')
    expect(text()).not.toContain('music.mp3')
    expect(text()).not.toContain('logo.png')

    fireEvent.click(tab('audio'))
    expect(text()).toContain('music.mp3')
    expect(text()).not.toContain('talk.mp4')
    expect(text()).not.toContain('logo.png')

    fireEvent.click(tab('image'))
    expect(text()).toContain('logo.png')
    expect(text()).not.toContain('talk.mp4')
    expect(text()).not.toContain('music.mp3')

    fireEvent.click(tab('all'))
    expect(text()).toContain('talk.mp4')
    expect(text()).toContain('music.mp3')
    expect(text()).toContain('logo.png')
  })
})
