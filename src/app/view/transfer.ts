/**
 * Getting a project file onto and off the disk.
 *
 * Both halves have a *better* API and a *universal* one, and the universal one
 * is the baseline rather than the fallback:
 *
 * - **Save:** `showSaveFilePicker` (Chromium) writes to a path the user chose
 *   and can overwrite in place. Everywhere else, a blob URL and a synthetic
 *   click, which downloads to the browser's folder. Same result, one more click.
 * - **Open:** `showOpenFilePicker` where available, otherwise `<input
 *   type="file">`, which works in every browser that exists.
 *
 * So the feature is not Chromium-gated. The API only makes it nicer, which is
 * the right way round: a nicer path should not be the only path.
 *
 * One subtlety worth keeping: **the picker is opened before any awaiting.**
 * `showSaveFilePicker` requires a user gesture, and fingerprinting every asset
 * takes long enough that by the time it finishes the gesture is gone and the
 * call rejects. So: ask where to save, then work, then write.
 */

import { log } from '../../dev/debug.js'

/** True when the browser can write to a path the user picks. */
export function canPickSavePath(): boolean {
  return typeof (window as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function'
}

export function canPickFiles(): boolean {
  return typeof (window as { showOpenFilePicker?: unknown }).showOpenFilePicker === 'function'
}

/** A writable sink: a file handle where available, otherwise null. */
export interface SaveTarget {
  write: (text: string) => Promise<void>
  /** True when the user cancelled rather than chose. */
  cancelled: boolean
}

interface FileSystemWritable {
  write: (data: string) => Promise<void>
  close: () => Promise<void>
}

interface FileHandleLike {
  createWritable: () => Promise<FileSystemWritable>
  name: string
}

/**
 * Ask where to save. Returns null when the user cancelled or the browser cannot.
 *
 * Kept separate from the writing so the caller can do its slow work in between
 * without losing the gesture.
 */
export async function chooseSaveTarget(suggested: string): Promise<SaveTarget | null> {
  const picker = (window as {
    showSaveFilePicker?: (options: unknown) => Promise<FileHandleLike>
  }).showSaveFilePicker
  if (typeof picker !== 'function') return null
  try {
    const handle = await picker({
      suggestedName: suggested,
      types: [{ description: 'Open editor project', accept: { 'application/json': ['.json'] } }],
    })
    return {
      cancelled: false,
      write: async (text: string) => {
        const writable = await handle.createWritable()
        await writable.write(text)
        await writable.close()
      },
    }
  } catch (err) {
    // AbortError is the user pressing Escape, which is not a failure.
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { cancelled: true, write: async () => {} }
    }
    log.warn('save picker refused', String(err))
    return null
  }
}

/** Save by download. Works everywhere, including where the picker is refused. */
export async function downloadText(text: string, filename: string): Promise<void> {
  const blob = new Blob([text], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
    // Revoked late: Safari and Firefox have been known to abort a download that
    // is still starting when the URL disappears.
    setTimeout(() => URL.revokeObjectURL(url), 30_000)
  } catch (err) {
    URL.revokeObjectURL(url)
    throw err
  }
}

/** Open a file picker and read the text. Null when cancelled. */
export async function chooseFileToRead(): Promise<{ name: string; text: string } | null> {
  const picker = (window as {
    showOpenFilePicker?: (options: unknown) => Promise<FileHandleLike[]>
  }).showOpenFilePicker
  if (typeof picker === 'function') {
    try {
      const [handle] = await picker({
        multiple: false,
        types: [{ description: 'Open editor project', accept: { 'application/json': ['.json'] } }],
      })
      if (!handle) return null
      const file = await (handle as unknown as { getFile: () => Promise<File> }).getFile()
      return { name: file.name, text: await file.text() }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return null
      log.warn('open picker refused', String(err))
      return null
    }
  }

  // The universal path. A real `<input>`, not a hand-rolled one, because the
  // dialog, the drag target and the keyboard all come for free.
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/json,.json'
    input.style.display = 'none'
    let settled = false
    const finish = (value: { name: string; text: string } | null): void => {
      if (settled) return
      settled = true
      input.remove()
      resolve(value)
    }
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) return finish(null)
      void file
        .text()
        .then((text) => finish({ name: file.name, text }))
        .catch((err) => {
          log.error('could not read the chosen file', String(err))
          finish(null)
        })
    })
    // `cancel` is not universal; the focus check is the fallback. Either way the
    // promise resolves, so a cancelled import can never leave the UI spinning.
    input.addEventListener('cancel', () => finish(null))
    document.body.appendChild(input)
    input.click()
  })
}

/**
 * Ask for one media file, and hand back the `File` itself.
 *
 * Separate from `chooseFileToRead` because the two want different things and,
 * more importantly, have different failure modes. A project file is read as
 * text the moment it is chosen; a media file has to survive as a `File` handle,
 * because the library and mediabunny both read its name and MIME type, and
 * because the relink path hashes the bytes.
 *
 * Falls back to a real `<input>` when there is no picker API, which is every
 * browser that is not Chromium. The `accept` list is left open on purpose: a
 * relink is often a file with the wrong extension, and refusing it at the
 * dialog would make the one case that needs help the hardest to reach.
 */
export async function chooseOneMediaFile(): Promise<File | null> {
  const picker = (window as {
    showOpenFilePicker?: (options: unknown) => Promise<FileHandleLike[]>
  }).showOpenFilePicker
  if (typeof picker === 'function') {
    try {
      const [handle] = await picker({
        multiple: false,
        // No `types` filter, deliberately: see above.
        excludeAcceptAllOption: false,
      })
      if (!handle) return null
      return await (handle as unknown as { getFile: () => Promise<File> }).getFile()
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return null
      log.warn('media picker refused', String(err))
      return null
    }
  }

  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = false
    input.style.display = 'none'
    let settled = false
    const finish = (value: File | null): void => {
      if (settled) return
      settled = true
      input.remove()
      resolve(value)
    }
    input.addEventListener('change', () => {
      finish(input.files?.[0] ?? null)
    })
    // A cancelled dialog fires no event in some browsers and a `cancel` event in
    // newer ones. Without this the promise never settles and the row's spinner
    // runs forever.
    input.addEventListener('cancel', () => finish(null))
    document.body.append(input)
    input.click()
  })
}
