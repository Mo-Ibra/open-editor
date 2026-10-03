/**
 * What state is each of the project's media files in?
 *
 * This is the review screen's whole brain, and it is a pure function on purpose.
 * Everything the screen shows — which assets are fine, which are near-misses,
 * which are absent, and *why* — is decided here, so it can be tested in Node
 * without a browser, a canvas, or an IndexedDB.
 *
 * The vocabulary is deliberately blunt, because these are the only three states
 * a person needs to act on:
 *
 * - `attached` — the file is here and the bytes are the ones the cuts were made
 *   against. Nothing to do.
 * - `rejected` — a file is here, and it is *not* the right one. Worth a look:
 *   "same name and size, different content" is a re-encode, which is usually
 *   what someone means to relink *deliberately* rather than by accident.
 * - `missing` — nothing here. Normal on a new machine.
 *
 * `rejected` is never `attached`. A file whose content differs was not what the
 * edit was cut against, and attaching it produces a project that exports
 * cleanly and is wrong — so it is reported, never applied.
 */

import type { Project } from '../../model/project.js'
import { isCertain, matchFingerprint, type Fingerprint, type Match } from './fingerprint.js'

/** A file this machine currently holds. */
export interface AvailableFile {
  assetId: string
  name: string
  size: number
  duration: number
  quickHash: string | null
}

export type MediaStatus = 'attached' | 'rejected' | 'missing'

export interface MediaState {
  assetId: string
  name: string
  status: MediaStatus
  /** Why, in words. Empty only for `attached`. */
  reason: string
  /** How many clips use it, so a missing file can be ranked by damage. */
  clipCount: number
  duration: number
  size: number
}

export function clipUseCount(project: Project, assetId: string): number {
  const inLane = (clips: { assetId: string }[]): number =>
    clips.filter((c) => c.assetId === assetId).length
  return inLane(project.video) + inLane(project.audio)
}

/**
 * Describe every asset in a project, given the files this machine holds.
 *
 * Assets the project never fingerprinted — imported on *this* machine, so
 * there was nothing to record — are `attached` by definition. Their bytes are
 * literally the ones the edit was built from.
 */
export function describeMedia(
  project: Project,
  wanted: Record<string, Fingerprint>,
  available: AvailableFile[],
): MediaState[] {
  const out: MediaState[] = []

  for (const [assetId, asset] of Object.entries(project.assets)) {
    const clipCount = clipUseCount(project, assetId)
    const have = available.find((f) => f.assetId === assetId)
    const base = {
      assetId,
      name: asset.name,
      clipCount,
      duration: asset.duration,
      size: asset.size,
    }

    // Present, and this machine's own copy. The strongest possible statement.
    if (have) {
      out.push({ ...base, status: 'attached', reason: 'on this machine' })
      continue
    }

    const want = wanted[assetId]
    if (!want) {
      out.push({ ...base, status: 'missing', reason: 'no file recorded for it' })
      continue
    }

    // Not on the machine under its own id, but somewhere we can see. Compare.
    const seen = available.map((f) => ({ file: f, match: matchFingerprint(want, f, asset.name, f.name) }))

    const certain = seen.find((c) => isCertain(c.match))
    if (certain) {
      out.push({ ...base, status: 'attached', reason: 'identical to the exported file' })
      continue
    }

    // `rejected` is reserved for the case we genuinely cannot judge: a plausible
    // file with no hash to check. That needs a human.
    const soft = seen.filter((c) => c.match.kind !== 'none')
    if (soft.length > 0) {
      out.push({ ...base, status: 'rejected', reason: soft[0]!.match.reason })
      continue
    }

    // A file with the right name and the wrong content is still *missing*, by
    // the decision that only identical bytes get attached — but the reason must
    // not claim nothing is here, because something is. That sentence is the
    // difference between "go and find it" and "this is the wrong file", and only
    // one of them is fixed by looking in another folder.
    const namesake = seen.find((c) => c.match.sameName)
    out.push({
      ...base,
      status: 'missing',
      reason: namesake ? namesake.match.reason : 'not on this machine',
    })
  }

  // The worst first, and the most-used first within that: a missing file that
  // ten clips depend on is the one to fix.
  const rank: Record<MediaStatus, number> = { rejected: 0, missing: 1, attached: 2 }
  return out.sort((a, b) => rank[a.status] - rank[b.status] || b.clipCount - a.clipCount)
}

export interface RelinkOutcome {
  ok: boolean
  reason: string
}

/**
 * Should this file be accepted as the project's copy of this asset?
 *
 * Called when a person picks a file for a missing asset, so it is a *human*
 * decision at that point — but the same certainty rule applies, and the reason
 * is what they will read afterwards. Someone who deliberately relinks to a
 * re-encode can still do it, deliberately, after reading why it was refused.
 */
export function decideRelink(want: Fingerprint | null, file: AvailableFile): RelinkOutcome {
  if (!want) {
    // Nothing was recorded, so there is nothing to check against. Refusing would
    // make imported projects impossible to relink, which is worse than an
    // unverified acceptance the user asked for by hand.
    return { ok: true, reason: 'no fingerprint recorded — accepted as chosen' }
  }
  const match: Match = matchFingerprint(want, file, '', file.name)
  if (isCertain(match)) return { ok: true, reason: 'identical' }
  return { ok: false, reason: match.reason }
}

// ---------------------------------------------------------------------------
// Batch relinking: matching a whole folder against a whole project
// ---------------------------------------------------------------------------

export interface BatchCandidate {
  file: AvailableFile
  match: Match
}

export interface BatchItem {
  assetId: string
  name: string
  clipCount: number
  /** The one file that is certainly right, if there is one. */
  certain: BatchCandidate | null
  /**
   * Plausible, but unverified. Shown, never applied — the user chose that, and
   * a folder is exactly where near-misses come from: twenty exports of the same
   * take, all named the same thing.
   */
  proposals: BatchCandidate[]
}

/**
 * Could this file *possibly* be the one, judging by things that cost nothing?
 *
 * This is the whole reason batch relinking is usable. A folder of media is
 * gigabytes; hashing all of it to find a 900 MB file is minutes of work and a
 * frozen tab. Name and size are free, and between them they rule out almost
 * everything, so only the survivors are ever read.
 *
 * Deliberately generous. A false positive costs a hash; a false negative silently
 * loses the file, and the user has no way to tell that happened. So: keep
 * anything sharing a name *or* a size, and let the hash decide.
 */
export function prefilter(want: Fingerprint, file: AvailableFile): boolean {
  if (file.size === want.size && file.size > 0) return true
  if (file.duration > 0 && want.duration > 0 && Math.abs(file.duration - want.duration) < 0.05) return true
  return false
}

/**
 * Decide, for every asset, which of these files should back it.
 *
 * Two properties this function exists to guarantee, both of which are easy to
 * get wrong and invisible when you do:
 *
 * - **A file backs at most one asset.** Without this, one plausible file is
 *   offered to five assets and "Relink all proposals" attaches the same clip
 *   five times — an edit that looks fine and is wrong in the only way that
 *   matters. Certain matches claim their file first, because they are the ones
 *   we are certain about.
 * - **Assets that are already attached are left out.** The folder is a place to
 *   fix what is broken, not to second-guess what already works.
 *
 * `available` must already carry hashes for the files worth hashing. Deciding
 * *which* files those are is `prefilter`'s job, and it happens before any I/O —
 * see `relinkFromFolder`.
 */
export function planBatch(
  project: Project,
  wanted: Record<string, Fingerprint>,
  available: AvailableFile[],
  skip: ReadonlySet<string> = new Set(),
): BatchItem[] {
  const pending = Object.entries(project.assets)
    .filter(([assetId]) => !skip.has(assetId))
    .map(([assetId, asset]) => ({
      assetId,
      name: asset.name,
      clipCount: clipUseCount(project, assetId),
      want: wanted[assetId] ?? null,
    }))
    .filter((e) => e.want !== null)
    // Most broken first, and the order is fixed *before* either pass runs, so
    // both passes compete for files in the same priority. That is what makes the
    // greedy claim below deterministic instead of depending on object key order.
    .sort((a, b) => b.clipCount - a.clipCount || a.name.localeCompare(b.name))

  const certain = new Map<string, BatchCandidate>()
  const claimed = new Set<string>()

  // Pass 1: certain matches, and they claim their file.
  //
  // This has to finish before any proposal is gathered. One pass that did both
  // would let an early asset collect file X as a *proposal*, and a later asset
  // then take X as a certain match — leaving the proposal list offering a file
  // that something else already owns. "Relink all proposals" would then attach
  // the same file twice, which is an edit that saves cleanly and is wrong.
  for (const entry of pending) {
    for (const file of available) {
      if (claimed.has(file.assetId)) continue
      const match = matchFingerprint(entry.want!, file, entry.name, file.name)
      if (!isCertain(match)) continue
      claimed.add(file.assetId)
      certain.set(entry.assetId, { file, match })
      break
    }
  }

  // Pass 2: proposals, from what is left. Sorted so the closest evidence leads,
  // and the first asset to want a file *claims* it — so the list never shows the
  // same file twice, which is what makes "Relink all proposals" safe to press
  // without a dry run.
  //
  // Greedy, and worth being honest about: with equal evidence the asset that
  // depends on the file most wins, and a better overall assignment is not
  // searched for. Solving it properly is an assignment problem, and the failure
  // mode of not solving it is one file left for a person to relink by hand —
  // visible, and reversible. The alternative, offering every file to every
  // asset, is not visible at all.
  const items: BatchItem[] = []
  for (const entry of pending) {
    const exact = certain.get(entry.assetId)
    if (exact) {
      items.push({ assetId: entry.assetId, name: entry.name, clipCount: entry.clipCount, certain: exact, proposals: [] })
      continue
    }
    const proposals: BatchCandidate[] = []
    for (const file of available) {
      if (claimed.has(file.assetId)) continue
      const match = matchFingerprint(entry.want!, file, entry.name, file.name)
      if (match.kind === 'none') continue
      claimed.add(file.assetId)
      proposals.push({ file, match })
    }
    items.push({
      assetId: entry.assetId, name: entry.name, clipCount: entry.clipCount,
      certain: null,
      proposals: proposals.sort((a, b) => score(b.match) - score(a.match)),
    })
  }

  // Resolved first, then the most broken first among the rest, so both the
  // progress line and the proposal list read in order of how much it matters.
  return items.sort(
    (a, b) => Number(b.certain !== null) - Number(a.certain !== null) || b.clipCount - a.clipCount,
  )
}

/** How much to trust a soft match, when nothing about it is certain. */
function score(match: Match): number {
  if (match.kind === 'same-name-size') return 2
  if (match.kind === 'same-name-duration') return 1
  return 0
}
