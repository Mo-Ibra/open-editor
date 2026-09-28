/**
 * The export self-check.
 *
 * **The tool plays its own output before offering the download.** "It
 * downloaded but won't play" is the worst class of bug, because it looks like
 * success until someone tries to watch the result — and the export is the only
 * thing here whose failure is invisible to the person editing.
 *
 * The awkward part is that a `<video>` element's evidence arrives in pieces, on
 * different browsers, at different times. So this reports **three** states, not
 * two, and a big part of the job is refusing to announce a disagreement on
 * inconclusive evidence.
 *
 * It lives beside the exporter rather than in the dialog because it is a
 * property of the *output*, not of the UI, and because the interesting half is
 * pure and therefore testable.
 */

/** What the video element knows about the file it just loaded. */
export interface MediaFacts {
  width: number
  height: number
  duration: number
  /** Chrome: empty until the tracks are actually enabled. */
  enabledTrackCount: number
  /** Chrome: 0 until something has decoded. */
  decodedBytes: number | undefined
  /** Firefox only. */
  mozHasAudio: boolean | undefined
}

export type Verdict = 'present' | 'absent' | 'not yet confirmed'

/**
 * Read the facts. The only part that needs a DOM.
 *
 * Every signal lies at a different moment, which is why `audioVerdict` has to
 * weigh them rather than OR them together.
 */
export function readMediaFacts(video: HTMLVideoElement): MediaFacts {
  const anyVideo = video as HTMLVideoElement & {
    mozHasAudio?: boolean
    webkitAudioDecodedByteCount?: number
    audioTracks?: ArrayLike<unknown>
  }
  return {
    width: video.videoWidth,
    height: video.videoHeight,
    // Raw. A streaming blob reports NaN or Infinity mid-load, and that is "not
    // known yet" — but the fix for that belongs in the formatter, which is the
    // only place the value becomes text. Guarding here as well would be the
    // same rule written twice, and the second copy is the one that rots.
    duration: video.duration,
    enabledTrackCount: anyVideo.audioTracks?.length ?? 0,
    decodedBytes: anyVideo.webkitAudioDecodedByteCount,
    mozHasAudio: anyVideo.mozHasAudio,
  }
}

/**
 * What the element knows about the file's audio.
 *
 * Every signal lies at a different moment: `audioTracks` is empty in Chrome
 * until the tracks are enabled, `webkitAudioDecodedByteCount` is 0 until
 * something has decoded, and `mozHasAudio` is Firefox only. So three states,
 * never two — announcing a disagreement on inconclusive evidence is worse than
 * saying nothing.
 */
export function audioVerdict(info: MediaFacts, weAddedAudio: boolean): Verdict {
  if (info.mozHasAudio === true) return 'present'
  if (info.mozHasAudio === false) return 'absent'
  if (info.decodedBytes !== undefined) {
    return info.decodedBytes > 0 ? 'present' : weAddedAudio ? 'not yet confirmed' : 'absent'
  }
  if (info.enabledTrackCount > 0) return 'present'
  return weAddedAudio ? 'not yet confirmed' : 'absent'
}

/** Whether this browser gives us any audio signal at all. */
export function canJudgeAudio(info: MediaFacts): boolean {
  return info.decodedBytes !== undefined || info.mozHasAudio !== undefined
}

/**
 * The one-line readout shown under the player.
 *
 * The only place a `MediaFacts` becomes text, and therefore the only place a
 * non-finite duration can leak. `NaNs` in the one diagnostic line makes the
 * whole line untrustworthy, which is worse than saying nothing.
 */
export function selfCheckLine(info: MediaFacts, weAddedAudio: boolean): string {
  const duration = Number.isFinite(info.duration) ? info.duration : 0
  const width = Number.isFinite(info.width) ? info.width : 0
  const height = Number.isFinite(info.height) ? info.height : 0
  return (
    `${width}×${height} · ${duration.toFixed(2)}s · ` +
    `audio ${audioVerdict(info, weAddedAudio)}`
  )
}

/**
 * The self-check for one playback event.
 *
 * Returns null when the browser cannot tell us anything yet, so the caller can
 * leave the previous line alone rather than replacing real information with a
 * shrug.
 */
export function selfCheck(video: HTMLVideoElement, weAddedAudio: boolean): string | null {
  const info = readMediaFacts(video)
  if (!canJudgeAudio(info)) return null
  return selfCheckLine(info, weAddedAudio)
}
