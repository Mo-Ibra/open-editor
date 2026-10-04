/**
 * Getting a folder's files, from a picker or from a drop.
 *
 * Two entirely different mechanisms that have to produce the same thing:
 *
 * - `webkitdirectory` — one attribute, and the browser does the walking. It is
 *   Chromium and Safari only, and it is the only option in those browsers, since
 *   `showDirectoryPicker` is not Firefox.
 * - A drop — `DataTransferItem.webkitGetAsEntry`, a real filesystem walk, in
 *   every browser that has supported directory drops for years. Which means
 *   Firefox's *only* way to give this app a folder is a drop.
 *
 * So both are needed, not one with a fallback. What they share is a limit: a
 * dragged folder can be a home directory, and walking one of those is tens of
 * thousands of `File` handles nobody asked for. Both paths stop at the same
 * ceiling rather than freezing the tab.
 */

import { log } from '../../../dev/debug.js'

/** Enough for any real shoot. Above this, someone dragged their home folder. */
export const MAX_FOLDER_FILES = 5000
/** Deep enough for `footage/2026/shoot-04/camera-a/`, shallow enough to be safe. */
export const MAX_FOLDER_DEPTH = 12

export interface FolderFile {
  file: File
  /** `shoot-04/camera-a/a001.mov`, or just the name at the top level. */
  path: string
}

interface FileSystemEntryLike {
  isFile: boolean
  isDirectory: boolean
  name: string
  file?: (cb: (entry: File) => void, err: (e: unknown) => void) => void
  createReader?: () => {
    readEntries: (cb: (entries: FileSystemEntryLike[]) => void, err: (e: unknown) => void) => void
  }
}

interface DataTransferItemLike {
  webkitGetAsEntry?: () => FileSystemEntryLike | null
  getAsFile?: () => File | null
}

/** Open the browser's directory picker. Null if cancelled or unavailable. */
export function chooseFolder(): Promise<FolderFile[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.webkitdirectory = true
    input.multiple = true
    input.style.display = 'none'
    let settled = false
    const finish = (value: FolderFile[] | null): void => {
      if (settled) return
      settled = true
      input.remove()
      resolve(value)
    }
    input.addEventListener('change', () => finish(fromFileList(input.files)))
    input.addEventListener('cancel', () => finish(null))
    document.body.append(input)
    input.click()
  })
}

/** Turn a picked folder's files into `{ file, path }`, deduplicated. */
export function fromFileList(files: FileList | File[] | null): FolderFile[] {
  if (!files) return []
  const out: FolderFile[] = []
  const seen = new Set<string>()
  for (const file of Array.from(files).slice(0, MAX_FOLDER_FILES)) {
    // `webkitRelativePath` is what makes a folder different from a pile of
    // files: two takes called `a001.mov` in two camera folders are different
    // files, and only the path tells them apart.
    const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
    const key = `${path}:${file.size}:${file.lastModified}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ file, path })
  }
  return out
}

/**
 * Every file under a drop, folders included.
 *
 * A recursive walk rather than `dataTransfer.files`, because that only ever
 * yields the top level — dropping a folder on a page gives you the folder
 * itself and nothing inside it, which is the single most common way a "drop
 * your media here" feature silently does nothing.
 */
export async function filesFromDrop(dt: DataTransfer | null): Promise<FolderFile[]> {
  // A synthetic or cancelled drop can arrive with no transfer at all, and
  // `Array.from(undefined)` throws where returning nothing is correct.
  if (!dt) return []
  const entries = Array.from(dt.items ?? [])
    .map((item) => (item as unknown as DataTransferItemLike).webkitGetAsEntry?.() ?? null)
    .filter((e): e is FileSystemEntryLike => e !== null)

  // No entry API (or a browser without it): fall back to the flat list, which
  // at least handles a multi-file drag.
  if (entries.length === 0) return fromFileList(dt.files)

  const out: FolderFile[] = []
  for (const entry of entries) {
    await walk(entry, '', out, 0)
    if (out.length >= MAX_FOLDER_FILES) {
      log.warn('folder: stopped at the file limit', { limit: MAX_FOLDER_FILES })
      break
    }
  }
  return out
}

async function walk(
  entry: FileSystemEntryLike,
  prefix: string,
  out: FolderFile[],
  depth: number,
): Promise<void> {
  if (out.length >= MAX_FOLDER_FILES) return
  const path = prefix ? `${prefix}/${entry.name}` : entry.name

  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) => {
      // Both callbacks are mandatory in the old API, and a file that cannot be
      // read must not take the whole walk down with it.
      try {
        entry.file?.(
          (f) => resolve(f),
          () => resolve(null),
        )
      } catch {
        resolve(null)
      }
    })
    if (file) out.push({ file, path })
    return
  }

  if (!entry.isDirectory) return
  if (depth >= MAX_FOLDER_DEPTH) {
    log.warn('folder: stopped at the depth limit', { depth: MAX_FOLDER_DEPTH, at: path })
    return
  }

  const reader = entry.createReader?.()
  if (!reader) return

  // `readEntries` returns at most ~100 at a time and signals the end with an
  // empty batch. A single call therefore silently loses most of a large folder —
  // the classic reason folder drops lose files.
  for (;;) {
    const batch = await new Promise<FileSystemEntryLike[]>((resolve) => {
      try {
        reader.readEntries(
          (e) => resolve(e),
          () => resolve([]),
        )
      } catch {
        resolve([])
      }
    })
    if (batch.length === 0) break
    for (const child of batch) {
      await walk(child, path, out, depth + 1)
      if (out.length >= MAX_FOLDER_FILES) return
    }
  }
}
