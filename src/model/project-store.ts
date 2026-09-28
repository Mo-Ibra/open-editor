/**
 * The one place the project store is written.
 *
 * This exists because of a bug that cost a whole media library.
 *
 * `setProject(replace(next))` used to be a plain two-key set, which is exactly
 * right: an edit changes the lanes and nothing else. It was "improved" to
 * `setProject(reconcile(next))`, and `reconcile` has this behaviour:
 *
 * ```js
 * const previousKeys = Object.keys(previous)
 * for (...) if (target[previousKeys[i]] === undefined) setProperty(previous, previousKeys[i], undefined)
 * ```
 *
 * Any key the target does not mention is set to `undefined`. Since `replace`
 * returns only `{ video, audio }`, every single edit silently deleted
 * `project.assets` and `project.version` — and the next `project.assets[id]`
 * threw `Cannot read properties of undefined`. The media library was not
 * deleted, only the reference to it.
 *
 * So: a plain set, deliberately. If you are reading this while tempted to add
 * `reconcile` for performance, the performance is not worth it.
 */

import type { Clip, Project } from './project.js'

/** The lanes alone, which is what an edit is allowed to change. */
export type Lanes = { video: Clip[]; audio: Clip[] }

export function lanesOf(project: Project): Lanes {
  return { video: project.video, audio: project.audio }
}

/**
 * Write the lanes and nothing else.
 *
 * `setter` is Solid's store setter, called with a single object so that a
 * single update fires one notification.
 */
export function applyLanes(
  setter: (value: Lanes) => void,
  lanes: Lanes,
  onWritten: () => void,
): void {
  setter({ video: lanes.video, audio: lanes.audio })
  // Run after the write: pruning reads the project, so it must see the new one.
  onWritten()
}
