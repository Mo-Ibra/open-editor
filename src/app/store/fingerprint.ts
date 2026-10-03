/**
 * Fingerprints: how a project file recognises its media on another machine.
 *
 * An exported project is the *edit* — a few kilobytes of JSON — and no media at
 * all. That is the right trade: the files already sit on the user's disk, and
 * making them zip up a copy they own is work with no benefit. The cost is that
 * on another machine the edit arrives with nothing to show, and this module is
 * how it finds its way back to the files.
 *
 * ## Why a fingerprint and not a path
 *
 * A path would be useless — it means nothing on another machine — and honouring
 * one from a file the user opened is an attack surface. So a project file never
 * contains a filesystem path. It contains *descriptions* of the bytes.
 *
 * ## The confidence ladder
 *
 * A fingerprint match is not one thing, it is several, and the difference
 * matters:
 *
 * | Evidence | Certainty | Action |
 * |---|---|---|
 * | `quickHash` equal | the bytes are the same | apply silently |
 * | name + size | almost certainly | **propose**, let the user confirm |
 * | name + duration | probably the same take | **propose** |
 * | name alone | a guess | offer, never apply |
 *
 * Only the first is applied without asking, and the reason is not caution for
 * its own sake. A wrong automatic match produces an export that looks correct
 * and is not — the worst outcome a video editor can hand someone, because
 * nothing about it looks wrong. An unresolved asset is a nuisance; a silently
 * wrong one is a lie.
 *
 * ## Why the hash is over a *sample*
 *
 * Reading a whole 4 GB file to check whether it is the file we already have is
 * not free, and the answer would almost never justify it. A megabyte off the
 * front, plus the size, plus the duration is a few milliseconds and is already
 * unique in practice.
 */

import type { Fingerprint } from '../../media/quick-hash.js'

export type { Fingerprint }
export { hashingAvailable, quickHash, fingerprintOf } from '../../media/quick-hash.js'

export type MatchKind = 'identical' | 'same-name-size' | 'same-name-duration' | 'none'

export interface Match {
  kind: MatchKind
  /** Why, in words a person can check. */
  reason: string
  /**
   * Whether the candidate carries the name we were looking for.
   *
   * Carried as data rather than left to be guessed from `reason`, because it
   * changes what the user is told. "Not on this machine" and "a file with that
   * name is here, but it is not the one" call for completely different
   * responses, and only one of them is fixed by finding the file elsewhere.
   */
  sameName: boolean
}

/**
 * How well does `candidate` look like what the project recorded?
 *
 * Pure, so the whole ladder — including the cases that must *not* match — is
 * unit tested. The dangerous outcomes are the false matches, and they are much
 * easier to write than they look: two different exports of the same take share a
 * name and a duration, and a re-encode can coincidentally match a size.
 */
export function matchFingerprint(
  want: Fingerprint,
  candidate: Fingerprint,
  /** The name the project recorded, and the name the file actually has. */
  wantName: string,
  candidateName: string,
): Match {
  // Names are passed separately because a `Fingerprint` deliberately does not
  // carry one — it describes bytes, and bytes have no name. Whether the names
  // agree is a separate question with its own answer, and folding it in would
  // mean a fingerprint was only ever valid for one file.
  const sameName = wantName.length > 0 && wantName === candidateName
  if (want.quickHash && candidate.quickHash) {
    // Both the hash *and* the size, never the hash alone.
    //
    // `quickHash` folds the size into its digest, so an equal hash already
    // implies an equal size — but relying on that coupling is fragile across
    // two files written by different versions, or by a tool that sampled
    // differently. Size is exact evidence and it is free, so an identity claim
    // has to agree on both. A size mismatch means it is a different file, full
    // stop.
    if (want.quickHash === candidate.quickHash && want.size === candidate.size) {
      return { kind: 'identical', reason: 'identical', sameName }
    }
    // Both are hashed and they differ. That is a *definite* no, whatever else
    // agrees — so do not fall through and offer it as a proposal, which is how a
    // confidently-wrong match gets one click of rubber-stamping.
    if (want.size !== candidate.size) {
      return { kind: 'none', reason: 'different content and a different size', sameName }
    }
    return { kind: 'none', reason: 'the content differs, despite the same name and size', sameName }
  }

  if (want.size === candidate.size) {
    return { kind: 'same-name-size', reason: `same name and size (${want.size} B), not verified`, sameName }
  }
  if (Math.abs(want.duration - candidate.duration) < 0.05) {
    return { kind: 'same-name-duration', reason: 'same name and duration, not verified', sameName }
  }
  return { kind: 'none', reason: sameName ? 'a file with that name is here, but it does not match' : 'nothing in common', sameName }
}

/** True only for a match safe to apply without asking. */
export function isCertain(match: Match): boolean {
  return match.kind === 'identical'
}
