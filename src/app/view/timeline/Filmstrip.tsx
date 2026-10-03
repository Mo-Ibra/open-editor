/**
 * A clip's filmstrip: one small frame per asset, tiled by the compositor.
 *
 * A single frame off the front of the file, repeated across the clip by CSS
 * (`repeat-x` + `background-size: auto 100%`). It is composited on the GPU, so
 * trimming or zooming a clip costs nothing — there is no canvas as wide as the
 * clip and no per-tile draw loop, which is what the first version did and why
 * the app stuttered.
 *
 * The frame itself comes from `thumbnail.ts`, shared with the media bin, so a
 * file shown in both places is decoded once.
 */

import { createEffect, createSignal, onCleanup, Show } from 'solid-js'
import type { Clip } from '../../../model/project.js'
import type { AppState } from '../../store/state.js'
import { thumbnailFor } from '../thumbnail.js'

export function Filmstrip(props: { clip: Clip; state: AppState }) {
  const [thumb, setThumb] = createSignal<string | null>(null)
  let disposed = false
  onCleanup(() => {
    disposed = true
  })

  createEffect(() => {
    // Only video has a frame; audio clips fall through to the waveform.
    if (!props.state.getAsset(props.clip.assetId)?.hasVideo) return
    void thumbnailFor(props.state, props.clip.assetId).then((url) => {
      if (!disposed) setThumb(url)
    })
  })

  return (
    <Show when={thumb()}>
      {(url) => (
        <div
          class="pointer-events-none absolute inset-0 opacity-50"
          style={{
            'background-image': `url(${url()})`,
            'background-repeat': 'repeat-x',
            'background-size': 'auto 100%',
          }}
        />
      )}
    </Show>
  )
}
