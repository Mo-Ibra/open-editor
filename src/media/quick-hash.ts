/**
 * Hashing a file, and whether that is even possible here.
 *
 * This lives in the media layer rather than the app store because both need it:
 * the media library remembers the hash of every file it holds, so the review
 * screen can recognise a file that is already on this machine, and the app store
 * needs it to fingerprint an export. Neither should import from the other, and
 * hashing bytes is plainly a media concern.
 *
 * The matching *ladder* — what to do with two fingerprints — is the opposite
 * case, so it stays in the app store next to the product decisions it encodes.
 */

/** Bytes read from the front of the file. */
const SAMPLE_BYTES = 1 << 20 // 1 MiB

/** Bytes read from the end as well, which catches trimmed or re-muxed files. */
const TAIL_BYTES = 64 << 10 // 64 KiB

export interface Fingerprint {
  /** Bytes. Cheap, and immediately wrong for anything that was re-encoded. */
  size: number
  /** Seconds. Two takes of the same length are common; same name and length is rarer. */
  duration: number
  /**
   * Hash of a sample. Null when hashing is unavailable — see
   * `hashingAvailable`, which is false outside a secure context.
   */
  quickHash: string | null
}

/**
 * Is hashing possible here?
 *
 * `crypto.subtle` is only exposed in a secure context, so this is false on a
 * plain-http host. Everything still works, matching falls back to name and
 * size, and `quickHash` is null so nothing pretends to have been verified. An
 * honest "we could not check" beats a hash that is always equal.
 */
export function hashingAvailable(): boolean {
  return typeof crypto !== 'undefined' && typeof crypto.subtle?.digest === 'function'
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * A hash of the head and tail of a blob, plus its size.
 *
 * Deliberately not the whole file, and deliberately not just the head: the tail
 * catches a file that was re-muxed from the front, and the size is folded into
 * the digest so two files with identical first and last megabyte but different
 * lengths still differ.
 */
export async function quickHash(blob: Blob): Promise<string | null> {
  if (!hashingAvailable()) return null
  try {
    const head = await blob.slice(0, Math.min(SAMPLE_BYTES, blob.size)).arrayBuffer()
    const tailStart = Math.max(0, blob.size - TAIL_BYTES)
    const tail = await blob.slice(tailStart, blob.size).arrayBuffer()

    // The size and the sample boundaries go *into* the digest, so a file that is
    // shorter than the sample is distinguishable from one that is exactly as
    // long as the sample but different.
    const header = new TextEncoder().encode(`open-editor:v1:${blob.size}:${head.byteLength}:${tail.byteLength}\n`)
    const combined = new Uint8Array(header.byteLength + head.byteLength + tail.byteLength)
    combined.set(header, 0)
    combined.set(new Uint8Array(head), header.byteLength)
    combined.set(new Uint8Array(tail), header.byteLength + head.byteLength)

    return toHex(await crypto.subtle.digest('SHA-256', combined))
  } catch {
    // A huge file can fail to allocate. A null hash downgrades matching rather
    // than failing the export, because the edit is the part that matters.
    return null
  }
}

/** Fingerprint a file we already hold. */
export async function fingerprintOf(file: Blob, duration: number): Promise<Fingerprint> {
  return { size: file.size, duration, quickHash: await quickHash(file) }
}
