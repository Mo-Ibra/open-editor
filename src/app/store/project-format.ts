/**
 * How a project is written to text, and how old text is brought forward.
 *
 * Split out from `persistence.ts` because this half is **pure** — no IndexedDB,
 * no DOM, no mediabunny — so it can be tested in Node, while the half that
 * needs a browser cannot be. The split is also the honest shape of the problem:
 * the *format* is a long-lived contract with the user's files, and the *storage*
 * is an implementation detail we are free to replace.
 *
 * ## The format is a promise
 *
 * Once someone has saved a project, its JSON outlives this version of the app.
 * A schema change therefore cannot be "just bump the version" — that turns
 * every existing file into a refusal. `MIGRATIONS` is the forward path, and it
 * is deliberately written now, while there is only one version, so that adding
 * the second is a data entry rather than a redesign.
 *
 * The rule: **never edit what version 2 means.** Add a step instead.
 */

import { parseProject, type Project } from '../../model/project.js'

/** The version this build writes. */
export const CURRENT_VERSION = 2

/**
 * Forward-only steps, keyed by the version they produce.
 *
 * Empty today, and that is the point. **v1 is deliberately absent**: it predates
 * the two-lane format, its clip model was different, and no honest conversion
 * exists — so a v1 file is refused rather than guessed at. The first real entry
 * will look like:
 *
 * ```ts
 * 3: (raw) => ({ ...raw, version: 3, clips: splitLegacyClip(raw.clips) }),
 * ```
 *
 * Each step takes the raw parsed JSON and returns the raw JSON of the next
 * version. Keeping them raw — not `Project` — is what lets a step exist at all:
 * a v2 project cannot be expressed as a v3 `Project`, because the types differ.
 */
export const MIGRATIONS: Record<number, (raw: Record<string, unknown>) => Record<string, unknown>> = {}

/** The record stored per project. Kept separate from the project itself. */
export interface StoredProject {
  id: string
  name: string
  created: number
  updated: number
  /** The serialised edit. */
  json: string
}

/**
 * The project's own data, with nothing that does not belong in a file.
 *
 * `version` is written from `CURRENT_VERSION` rather than copied from the live
 * project, so a project object that somehow carried a stale version is corrected
 * on the way out instead of being written and then refused on the way back in.
 */
export function serialiseProject(project: Project): string {
  const out: Record<string, unknown> = {
    version: CURRENT_VERSION,
    assets: project.assets,
    video: project.video,
    audio: project.audio,
  }
  // Only when set. An empty captions track is noise in a saved file, and
  // `parseProject` already treats absence as "none".
  if (project.captions) out.captions = project.captions
  return JSON.stringify(out)
}

/**
 * Parse a stored project, migrating it forward if it is old.
 *
 * Throws with a message meant for a person, because the alternative — opening a
 * half-broken project — loses the edit, which is the one irreplaceable thing
 * here. Media can be re-imported; a mangled timeline cannot.
 */
export function migrateProject(text: string): Project {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new Error(`This project file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (typeof raw !== 'object' || raw === null) throw new Error('This project file is empty or not an object')

  const claimed = (raw as { version?: unknown }).version
  if (typeof claimed !== 'number') {
    throw new Error('This project file has no version, so it cannot be opened safely.')
  }
  let version: number = claimed

  if (version > CURRENT_VERSION) {
    throw new Error(
      `This project was saved by a newer version of the editor (v${version}). ` +
        'Update the app to open it — nothing has been lost.',
    )
  }

  // Walk forward one version at a time. Every step is a pure function of the
  // raw JSON, so a chain of three is as easy to reason about as one.
  while (version < CURRENT_VERSION) {
    const step = MIGRATIONS[version + 1]
    if (!step) {
      // The one message for "this file is from a shape we cannot read", whether
      // that is because the format is old or because a step was forgotten. Two
      // different messages for one situation is how users get told the wrong
      // thing.
      throw new Error(
        `This project is v${version}, which this version of the editor cannot open. ` +
          'Projects saved before the two-lane timeline format are not convertible. ' +
          'The file has not been changed.',
      )
    }
    raw = step(raw as Record<string, unknown>)
    version = (raw as { version?: unknown }).version as number
  }

  // The final word belongs to the model: it owns the shape and its validation.
  return parseProject(JSON.stringify(raw))
}
