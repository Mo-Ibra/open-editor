/**
 * The portable project file: what goes out, and what comes back in.
 *
 * **The edit only.** A 40-clip project is under 4 KB, and the media is not
 * included — the user already has those files, and making them zip up a copy
 * they own is work with no benefit. What travels instead is a
 * *fingerprint* per asset, so the edit can find its way back to the files on
 * another machine.
 *
 * **Plain JSON, on purpose.** A file you can open in a text editor is a feature:
 * the difference between "the project format is broken, let me look" and "the
 * app says no". A zip would be defensible if the media were inside; without it,
 * a zip is only a file you cannot read.
 *
 * ## Two version numbers, deliberately
 *
 * `formatVersion` is this envelope's own version, and `project.version` is the
 * model's. They move for different reasons and at different times, and
 * conflating them is how a project file becomes unopenable the first time the
 * envelope gains a field. A file from a *newer* build is refused with a message
 * that says the file is fine and only the app is behind — the same rule
 * [ADR-10](../../../docs/decisions/0010-copy-media-and-reopen-what-you-can.md)
 * uses for saved projects.
 *
 * ## Where the fingerprint lives
 *
 * In `media`, beside the project — not inside `Asset`. The model never learns
 * that hashing exists, and still receives exactly the `parseProject` shape it
 * already handles. That separation is what keeps this from turning into a
 * project-wide refactor.
 *
 * Only the fields the model does *not* already hold are duplicated here. The
 * name, dimensions and codecs are in `project.assets`; `media` adds the three
 * things needed to recognise a file elsewhere.
 */

import { parseProject, type Project } from '../../model/project.js'
import type { Fingerprint } from './fingerprint.js'

export const EXPORT_FORMAT = 'open-editor.project'
export const EXPORT_FORMAT_VERSION = 1

export interface ExportedMedia {
  size: number
  duration: number
  quickHash: string | null
}

export interface ProjectFile {
  format: typeof EXPORT_FORMAT
  formatVersion: number
  savedAt: number
  /**
   * The project's name at export.
   *
   * In the envelope rather than the model, for the same reason the fingerprints
   * are: the editing core has no opinion about files. Without it every import
   * landed as "Imported project", which is the one piece of context a person
   * would have recognised instantly.
   */
  name: string
  /** Best-effort app version, so a confusing file can be traced to a build. */
  app?: string
  /** Where the playhead was. Opening someone else's edit and landing at their
   *  exact frame is a small courtesy; the alternative is arriving at zero. */
  playhead?: number
  selection?: string[]
  project: Project
  media: Record<string, ExportedMedia>
}

/** Build the envelope. The fingerprints are gathered by the caller. */
export function buildProjectFile(
  project: Project,
  media: Record<string, ExportedMedia>,
  extra: { playhead?: number; selection?: string[]; app?: string; name?: string } = {},
): string {
  const file: ProjectFile = {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    savedAt: Date.now(),
    name: extra.name ?? 'Imported project',
    ...(extra.app ? { app: extra.app } : {}),
    ...(extra.playhead !== undefined ? { playhead: extra.playhead } : {}),
    ...(extra.selection && extra.selection.length > 0 ? { selection: extra.selection } : {}),
    project,
    media,
  }
  return JSON.stringify(file, null, 2)
}

export interface ImportedProject {
  project: Project
  media: Record<string, ExportedMedia>
  playhead: number
  selection: string[]
  savedAt: number
  /** The name the project had when it was exported. */
  name: string
}

/**
 * Parse an exported file, or throw something a person can act on.
 *
 * Every failure is one of three shapes, and the messages distinguish them on
 * purpose: the file is not ours, the file is from a newer app, or the file is
 * ours but damaged. "Cannot open" for all three would leave a user with no idea
 * whether to update the app, re-export, or send the file to someone.
 */
export function parseProjectFile(text: string): ImportedProject {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new Error(
      `That file is not valid JSON${err instanceof Error ? ` (${err.message})` : ''}. ` +
        'If you meant to export a project, export it again from the project list.',
    )
  }

  if (typeof raw !== 'object' || raw === null) {
    throw new Error('That file is empty or not a project.')
  }
  const file = raw as Partial<ProjectFile>

  if (file.format !== EXPORT_FORMAT) {
    throw new Error('That file was not exported from this editor.')
  }
  if (typeof file.formatVersion !== 'number') {
    throw new Error('That file has no format version, so it cannot be opened safely.')
  }
  if (file.formatVersion > EXPORT_FORMAT_VERSION) {
    throw new Error(
      `That project was exported by a newer version of the editor (format v${file.formatVersion}). ` +
        'Update the app to open it — the file has not been changed.',
    )
  }

  // The model validates the edit. A file whose envelope is fine but whose
  // timeline is damaged is refused here rather than loaded into a broken state.
  const project = parseProject(JSON.stringify(file.project))

  const media: Record<string, ExportedMedia> = {}
  const rawMedia = file.media
  if (rawMedia && typeof rawMedia === 'object') {
    for (const [assetId, value] of Object.entries(rawMedia as Record<string, unknown>)) {
      const m = value as Partial<ExportedMedia> | null
      if (!m || typeof m !== 'object') continue
      // A fingerprint with no size is useless for matching, but its presence or
      // absence must not stop the *edit* from opening.
      media[assetId] = {
        size: typeof m.size === 'number' ? m.size : 0,
        duration: typeof m.duration === 'number' ? m.duration : 0,
        quickHash: typeof m.quickHash === 'string' ? m.quickHash : null,
      }
    }
  }

  return {
    project,
    media,
    playhead: typeof file.playhead === 'number' && Number.isFinite(file.playhead) ? file.playhead : 0,
    selection: Array.isArray(file.selection) ? file.selection.filter((s): s is string => typeof s === 'string') : [],
    savedAt: typeof file.savedAt === 'number' ? file.savedAt : 0,
    // A file with no name is from a build that predates the field, or was
    // hand-edited. Either way the edit still opens; only the label is a guess.
    name: typeof file.name === 'string' && file.name.trim() ? file.name.trim() : 'Imported project',
  }
}

/** Fingerprint for an asset, or null when the project never recorded one. */
export function fingerprintFor(media: Record<string, ExportedMedia>, assetId: string): Fingerprint | null {
  const m = media[assetId]
  if (!m) return null
  return { size: m.size, duration: m.duration, quickHash: m.quickHash }
}
