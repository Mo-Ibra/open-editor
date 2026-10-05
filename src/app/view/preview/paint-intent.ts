/**
 * What the preview should paint at a given moment.
 *
 * **Black is a decision, and this is where it is made.** It used to be made
 * inline in three places in `Preview.tsx`, which is how the three came to
 * disagree:
 *
 * | | painted? | reported as |
 * |---|---|---|
 * | a hidden clip | yes | deliberate |
 * | a gap | **no** | a warning |
 * | no decoder | **no** | a fault |
 *
 * Two of those left the last decoded frame sitting on the canvas, so the picture
 * froze on the last frame of the previous clip. For a gap that is not cosmetic:
 * the exporter writes black for every gap (`emitBlankUntil`, and `trackDuration`'s
 * docstring says "the video holds black for it"), so a preview showing a frozen
 * frame is showing something the exported file will not contain. That is the
 * exact failure [ADR-1] exists to prevent — one render function, so preview and
 * export cannot drift.
 *
 * So the distinction this file draws is not "blank or not", it is **an edit or a
 * fault**:
 *
 * - `fault: null` — the blackness is something the user did. A gap, a hidden
 *   clip, a clip with no picture track. Paint black and say nothing. Reporting it
 *   teaches the reader to ignore reports, and the next real one goes unread.
 * - `fault: <why>` — something is actually wrong: media gone from the library, or
 *   a decoder that will not open. Paint black *and* say so, because "I can see
 *   nothing here" with no explanation is the failure mode that costs hours.
 *
 * **Which clip wins when there is more than one video track.** The tracks are
 * walked top-down — a later video track sits above an earlier one, the way a
 * layer stack paints — and the first track with a clip covering `t` decides:
 *
 * - a **gap** (no clip here) is a hole: the walk continues to the track below;
 * - a **hidden** clip is deliberate black and stops the walk — the model's own
 *   rule is "draw black for this clip", and honouring it means a hidden overlay
 *   occludes what is under it rather than vanishing;
 * - a **fault** stops the walk too: the topmost content is what the user expects
 *   to see, and falling through would hide the very thing that needs reporting.
 *
 * Source frames are opaque, so at most one clip ever reaches `renderFrame` — the
 * "compositing" is this selection, and both preview and export call it. That is
 * what keeps ADR-1 true across tracks.
 *
 * In a `.ts` file, not a `.tsx` one, and that is not tidiness: Node's type
 * stripping cannot load `.tsx` at all, so pure logic placed beside a component is
 * untested by construction. See `ticks.ts` and `paintIntentAt` for the same reason.
 *
 * [ADR-1]: ../docs/decisions/0001-one-render-function.md
 */

import { clipAtTrack, sourceTimeAt, type Clip, type ClipLocation } from '../../../model/project.js'

export type PaintIntent =
  /** Paint black. `fault` is why, when why is a fault rather than an edit. */
  | { kind: 'blank'; fault: string | null }
  /** Decode `sourceTime` from the clip at `loc` and draw it. */
  | { kind: 'decode'; loc: ClipLocation; sourceTime: number }

/**
 * Why a clip cannot be decoded, or null when it can.
 *
 * A callback rather than a lookup table so this file stays free of the media
 * library: the caller knows what "gone" and "will not open" look like for the
 * browser it is running in, and this only needs to know that they are different
 * from "fine".
 */
export type Unavailable = (clip: Clip) => string | null

/**
 * Decide what to paint at timeline time `t`.
 *
 * `videoTracks` are the video tracks in paint order (first at the bottom). One
 * lookup per track top-down, and the `ClipLocation` that decides is handed back
 * — `clipAtTrack` sums the track from the start on every call, so making the
 * caller ask twice is worth the wider return type.
 *
 * A project with no video tracks is the empty timeline: black, no fault.
 */
export function paintIntentAt(
  videoTracks: readonly Clip[][],
  t: number,
  unavailable: Unavailable,
): PaintIntent {
  for (let i = videoTracks.length - 1; i >= 0; i--) {
    const loc = clipAtTrack(videoTracks[i]!, t)

    // No clip here. That is a **gap**, and a gap is part of the timeline rather
    // than the absence of one — `trackDuration` counts it, `frameTimesForClip`
    // counts it, and the exporter fills it with black. It is a hole in *this*
    // track: the track below shows through, or black if there is none.
    if (!loc) continue

    // Also an edit, and also cheap: no decode, no cache entry, nothing drawn but
    // a fill. `clipRendersBlack` covers the same two cases on the export side.
    // It stops here: a hidden clip is black over whatever lies beneath it.
    if (loc.clip.hidden) return { kind: 'blank', fault: null }

    const fault = unavailable(loc.clip)
    if (fault) return { kind: 'blank', fault }

    return { kind: 'decode', loc, sourceTime: sourceTimeAt(loc, t) }
  }

  return { kind: 'blank', fault: null }
}
