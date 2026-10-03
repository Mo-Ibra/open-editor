/**
 * The project store: what is open, what is saved, and what was lost.
 *
 * ## What gets written, and when
 *
 * The **media bytes are written once**, when a file is first imported, and are
 * never rewritten. The **edit is written on every change**, debounced. That
 * split is the whole reason autosave is affordable: a save is a few kilobytes
 * of JSON, not a gigabyte of video.
 *
 * ## Why the media is copied at all
 *
 * A `File` is a handle the operating system gave us, and after a reload nothing
 * can get it back. A saved path would be worth nothing, because the web platform
 * cannot reopen a file by path. So the bytes go into browser storage, and a
 * project costs roughly as much disk as its media. `usage()` exists to make that
 * visible instead of surprising.
 *
 * ## Reopening never destroys the edit
 *
 * A project whose media has gone — evicted, or a project copied between
 * browsers — **still opens**. The clips stay, the timeline stays, and the
 * assets that could not be rebuilt are reported in `missing`. The edit is the
 * irreplaceable part; media can be re-imported, and refusing to open would throw
 * away work to avoid a warning.
 */

import { createSignal } from 'solid-js'
import {
  copyMedia,
  createProject,
  deleteProject,
  getMedia,
  getMeta,
  listProjects,
  loadProject,
  mediaIds,
  openProjectDb,
  pruneMedia,
  putMedia,
  renameProject,
  requestPersistence,
  saveProject,
  setMeta,
  storageUsage,
  LAST_OPEN,
  type ProjectSummary,
  type StorageUsage,
} from './persistence.js'
import { migrateProject, serialiseProject } from './project-format.js'
import { buildProjectFile, fingerprintFor, parseProjectFile, type ExportedMedia } from './project-file.js'
import { fingerprintOf, matchFingerprint, isCertain, hashingAvailable } from './fingerprint.js'
import {
  decideRelink,
  describeMedia,
  planBatch,
  prefilter,
  type AvailableFile,
  type BatchItem,
  type MediaState,
} from './media-status.js'
import { log } from '../../dev/debug.js'
import { newId, type Asset, type Project } from '../../model/project.js'
import type { Fingerprint } from './fingerprint.js'

/** Autosave waits this long after the last change. */
const AUTOSAVE_MS = 700

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error'

export interface MissingMedia {
  assetId: string
  name: string
  reason: string
}

export interface ProjectSliceDeps {
  /** Read the live project at save time. A thunk, not a value: it changes. */
  read: () => Project
  /** Replace the whole project. The only way anything loads in. */
  write: (project: Project) => void
  /**
   * Rebuild one asset from a stored file. Returns why it failed if it did.
   *
   * A `File` and not a `Blob`: the library and mediabunny both read the name and
   * the MIME type, and a bare blob would report `blob` as the filename.
   */
  rehydrate: (
    asset: Asset,
    file: File,
  ) => Promise<{ ok: boolean; reason?: string; probed?: Asset }>
  /** Every File currently held, so media can be written on demand. */
  fileFor: (assetId: string) => File | null
  /**
   * What the media library currently holds, as plain data.
   *
   * The library is a `Map`, so it is not reactive and cannot be read from a
   * component. Going through a thunk keeps the review screen honest about that:
   * it re-reads on every render, and the component's own signal changes when
   * something does.
   */
  libraryEntries: () => { assetId: string; name: string; size: number; duration: number; quickHash: string | null }[]
  /** Overwrite one asset's metadata, after a re-probe disagreed with storage. */
  writeAsset: (asset: Asset) => void
  /** Drop the open project's decoders, so they are not carried to another one. */
  releaseLibrary: () => void
  /** Re-add a file to the emptied library, under the id the import gave it. */
  restoreFile: (file: File, assetId: string, name: string) => Promise<void>
  select: (clipIds: string[]) => void
  seek: (time: number) => void
  playhead: () => number
  selected: () => readonly string[]
  /** How to show the user something. */
  notify: (kind: 'info' | 'warn' | 'error', text: string) => void
}

export function createProjectStore(deps: ProjectSliceDeps) {
  const [id, setId] = createSignal<string | null>(null)
  const [name, setName] = createSignal('Untitled')
  const [saveState, setSaveState] = createSignal<SaveState>('idle')
  const [projects, setProjects] = createSignal<ProjectSummary[]>([])
  const [missing, setMissing] = createSignal<MissingMedia[]>([])
  const [usage, setUsage] = createSignal<StorageUsage>({ used: 0, quota: 0, persisted: false })
  /** Set when storage is unusable, so the UI can stop promising autosave. */
  const [storageError, setStorageError] = createSignal<string | null>(null)

  let timer: ReturnType<typeof setTimeout> | undefined
  let lastSavedJson = ''
  /** Probed metadata per project, applied after the project is written. */
  const probed = new Map<string, Asset[]>()

  // --- the current project ------------------------------------------------

  function ensureId(): string {
    const existing = id()
    if (existing) return existing
    const fresh = newId('prj')
    setId(fresh)
    return fresh
  }

  function markDirty(): void {
    if (saveState() === 'saving') return
    setSaveState('dirty')
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      void saveNow()
    }, AUTOSAVE_MS)
  }

  /**
   * Write the edit now.
   *
   * Errors are reported rather than swallowed. A silent autosave is the worst
   * failure available for this feature: the user believes their work is safe, and
   * finds out at reload that none of it was.
   */
  async function saveNow(): Promise<boolean> {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    const project = deps.read()
    const json = serialiseProject(project)
    if (json === lastSavedJson) {
      setSaveState('saved')
      return true
    }

    const projectId = ensureId()
    setSaveState('saving')
    try {
      await saveProject(projectId, project, name())
      lastSavedJson = json
      setSaveState('saved')
      setStorageError(null)
      return true
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error('persistence: save failed', message)
      setSaveState('error')
      setStorageError(message)
      deps.notify('error', `Could not save: ${message}. Your work is still on screen — copy something out before you reload.`)
      return false
    }
  }

  // --- media --------------------------------------------------------------

  /**
   * Store an asset's bytes, once.
   *
   * Called on import and never again. If the bytes are already stored the write
   * is skipped, so a re-import of the same file does not double the disk cost.
   */
  async function rememberMedia(assetId: string, file: File): Promise<void> {
    // `ensureId` rather than bailing: a file can be dropped before storage has
    // finished opening, and a media write that quietly did nothing is how a
    // project ends up with clips and no bytes.
    const projectId = ensureId()
    try {
      const existing = await getMedia(projectId, assetId)
      if (existing && existing.size === file.size) return
      await putMedia(projectId, assetId, file)
    } catch (err) {
      log.warn('persistence: could not store media', String(err))
      deps.notify('warn', 'The file was added, but its bytes could not be saved — this project will not survive a reload with its media.')
    }
  }

  /**
   * Rebuild the library from stored bytes, **before** the project is written.
   *
   * The order is the whole subtlety. `MediaLibrary` is a plain `Map`, so it is
   * not reactive: the media bin's rows read it with
   * `<Show when={state.entryFor(id)}>`, which evaluates once and never re-checks.
   * Writing the project first therefore creates the rows while the library is
   * still empty, and they stay invisible — a bin showing its populated branch
   * with nothing in it, while the clip titles (which read the store) looked
   * perfectly fine.
   *
   * Importing has always had the other order — `library.add` first, then
   * `setAsset` — so nothing noticed until a project was reopened.
   *
   * Each asset is independent: one that will not load is reported and the rest
   * carry on. A project that is 95% intact is far more useful than a refusal.
   */
  async function rehydrateAll(projectId: string, project: Project): Promise<void> {
    const gone: MissingMedia[] = []
    const reProbed: Asset[] = []
    const assetIds = Object.keys(project.assets)

    for (const assetId of assetIds) {
      const asset = project.assets[assetId]!
      const blob = await getMedia(projectId, assetId)
      if (!blob) {
        gone.push({ assetId, name: asset.name, reason: 'the file is not stored with this project' })
        continue
      }
      // A `File` rather than a `Blob`: the library and mediabunny both want a
      // name and a type, and a bare blob would report `blob` as the filename.
      const file = new File([blob], asset.name, { type: blob.type || guessMime(asset.name) })
      const result = await deps.rehydrate(asset, file)
      if (!result.ok) {
        gone.push({ assetId, name: asset.name, reason: result.reason ?? 'the file could not be read' })
      } else if (result.probed && JSON.stringify(result.probed) !== JSON.stringify(asset)) {
        // The probe disagrees with what was stored, and the bytes are the truth.
        // Applied *after* the project is written, not before.
        reProbed.push(result.probed)
      }
    }

    probed.set(projectId, reProbed)
    setMissing(gone)
    if (gone.length > 0) {
      deps.notify(
        'warn',
        gone.length === 1
          ? `Opened, but the media for "${gone[0]!.name}" is missing. The clip is still there — re-import the file to see it.`
          : `Opened, but ${gone.length} files are missing their media. The clips are all still there — re-import the files to see them.`,
      )
    }
  }

  // --- lifecycle ----------------------------------------------------------

  /** Load a project, replacing whatever is open. Unsaved work is saved first. */
  async function open(targetId: string): Promise<boolean> {
    if (id() && id() !== targetId) await saveNow()

    const record = await loadProject(targetId)
    if (!record) {
      deps.notify('error', 'That project could not be found. It may have been deleted in another tab.')
      return false
    }

    let project: Project
    try {
      project = migrateProject(record.json)
    } catch (err) {
      deps.notify('error', err instanceof Error ? err.message : String(err))
      return false
    }

    setId(targetId)
    setName(record.name)
    lastSavedJson = record.json
    setMissing([])
    // A locally saved project carries no fingerprints — they describe a file on
    // another machine. Clearing here stops the previous import's fingerprints
    // from being compared against this project's assets.
    setWantedFingerprints({})
    setSaveState('saved')
    // Library first, then the project. See `rehydrateAll` for why.
    deps.releaseLibrary()
    await rehydrateAll(targetId, project)
    deps.write(project)
    for (const asset of probed.get(targetId) ?? []) deps.writeAsset(asset)
    await persistLastOpen(targetId)
    log.info(`persistence: opened ${record.name} (${project.video.length + project.audio.length} clips)`)
    return true
  }

  /**
   * Start a new, empty project. The current one is saved first.
   *
   * `unlessBusy` exists for boot: storage opens asynchronously, and a user who
   * drops a file in that window must not have it wiped by the app deciding it
   * had no project. A boot that clobbers the first thirty seconds of someone's
   * work is worse than a boot that does nothing.
   */
  async function startNew(projectName = 'Untitled', unlessBusy = false): Promise<string> {
    if (unlessBusy) {
      const live = deps.read()
      if (live.video.length > 0 || live.audio.length > 0 || Object.keys(live.assets).length > 0) {
        // Something already exists. Keep it, and make sure it has a record.
        const projectId = ensureId()
        await createProject(projectId, name(), live)
        lastSavedJson = serialiseProject(live)
        setSaveState('saved')
        return projectId
      }
    }
    if (id()) await saveNow()
    const fresh = newId('prj')
    const blank: Project = { version: 2, assets: {}, video: [], audio: [] }
    // The old decoders go with the old project. Leaving them means the new
    // project's bin shows the previous project's files.
    deps.releaseLibrary()
    await createProject(fresh, projectName, blank)
    setId(fresh)
    setName(projectName)
    setMissing([])
    setWantedFingerprints({})
    lastSavedJson = serialiseProject(blank)
    setSaveState('saved')
    deps.write(blank)
    await persistLastOpen(fresh)
    await refreshList()
    return fresh
  }

  /**
   * Open whatever was open last time, or start a new one.
   *
   * Called once at boot. It must never throw and never block the app: a failure
   * here leaves an empty project and a warning, which is a far better outcome
   * than a blank screen.
   */
  async function boot(): Promise<void> {
    if (!(await openProjectDb())) {
      setStorageError('This browser will not give the app storage, so projects cannot be saved.')
      deps.notify('warn', 'Storage is unavailable, so this session will not be saved. Private browsing often causes this.')
      await startNew('Untitled', true)
      return
    }

    void requestPersistence()
    await refreshList()

    const last = await lastOpen()
    if (last) {
      const opened = await open(last)
      if (opened) return
    }
    const started = await startNew('Untitled', true)
    log.info(`persistence: booted as a new project (${started})`)
    setUsage(await storageUsage())
  }

  async function persistLastOpen(projectId: string): Promise<void> {
    try {
      await setMeta(LAST_OPEN, projectId)
    } catch (err) {
      log.warn('persistence: could not remember the open project', String(err))
    }
  }

  async function lastOpen(): Promise<string | null> {
    try {
      return await getMeta(LAST_OPEN)
    } catch {
      return null
    }
  }

  /**
   * Fingerprints carried in by the most recent import, keyed by asset id.
   *
   * Not persisted. They describe the file on *another* machine, and once the
   * media is attached here they are the wrong thing to compare against: this
   * machine's copy is the reference. They earn their keep only in the window
   * between "opened a project" and "the media is settled", which is exactly the
   * window the review screen exists for.
   */
  const [wantedFingerprints, setWantedFingerprints] = createSignal<Record<string, Fingerprint>>({})

  /** Every asset in the open project, and what state its media is in. */
  function mediaStatus(): MediaState[] {
    return describeMedia(deps.read(), wantedFingerprints(), deps.libraryEntries())
  }

  /**
   * Point one asset at a file the user picked.
   *
   * The same certainty rule as import, because a wrong attachment is the same
   * failure either way: a project that saves and exports cleanly and is not the
   * edit you made. A refusal is reported rather than thrown, so the review
   * screen can show it on the row it happened to.
   */
  async function relinkAsset(assetId: string, file: File): Promise<{ ok: boolean; reason: string }> {
    const asset = deps.read().assets[assetId]
    if (!asset) return { ok: false, reason: 'that asset is not in this project' }

    const want = wantedFingerprints()[assetId] ?? null
    // The duration comes from the asset, not the file: a file being relinked
    // into an asset is precisely the case where the library has not measured it
    // yet, and zero would make every duration comparison fail.
    const printed = await fingerprintOf(file, asset.duration)
    const size = printed.size || file.size

    // The asset's own duration is the right reference for a file being compared
    // against it, not the library's — the library may not have this asset yet,
    // which is the whole reason someone is relinking it.
    const decision = decideRelink(
      want ? { size: want.size, duration: want.duration || asset.duration, quickHash: want.quickHash } : null,
      { assetId, name: file.name, size, duration: asset.duration, quickHash: printed.quickHash },
    )
    if (!decision.ok) return decision

    await rememberMedia(assetId, file)
    await deps.restoreFile(file, assetId, file.name)
    // The name comes from the file the user chose: they may have relabelled it,
    // and a relink is a deliberate act, so their naming should stand.
    deps.writeAsset({ ...asset, name: file.name, size })
    // The reference is now this machine's file, so the imported fingerprint has
    // done its job and is retired.
    setWantedFingerprints((prev) => {
      const next = { ...prev }
      delete next[assetId]
      return next
    })
    markDirty()
    return { ok: true, reason: 'relinked' }
  }

  /**
   * The batch relink, from a folder of files.
   *
   * The order is the whole design. A folder is gigabytes, so nothing is read
   * until `prefilter` has ruled it out on name and size — free — and only the
   * survivors are hashed. `planBatch` then decides the assignment, purely, and
   * only the certain matches are applied here. Proposals are handed back for
   * someone to confirm, because that is the decision the user reserved.
   *
   * `onProgress` is called with counts rather than a message so the caller can
   * render a bar without knowing what it is doing.
   */
  async function relinkFromFolder(
    files: { file: File; path: string }[],
    onProgress?: (done: number, total: number, label: string) => void,
  ): Promise<{ attached: string[]; proposals: BatchItem[]; unreadable: string[]; hashed: number }> {
    const project = deps.read()
    const wanted = wantedFingerprints()

    // The unresolved set, and the cheap prefilter, decided before any I/O.
    const targets = Object.entries(project.assets)
      .filter(([assetId]) => !deps.libraryEntries().some((e) => e.assetId === assetId))
      .map(([assetId, asset]) => ({ assetId, name: asset.name, want: wanted[assetId] ?? null }))
      .filter((t) => t.want !== null)

    const durations = new Map<string, number>()
    for (const t of targets) durations.set(t.assetId, project.assets[t.assetId]!.duration)

    // Which files are even worth reading, and against what duration.
    //
    // The duration is the *target asset's*, not the file's: a file in a folder
    // has not been probed, and a zero would fail every duration comparison and
    // quietly exclude files that would have matched on it. When several assets
    // want the same file, the first one it passed for decides the reference,
    // which only matters for soft matches — a certain one is certain either way.
    const worth = new Map<string, number>()
    for (const t of targets) {
      const duration = project.assets[t.assetId]!.duration
      for (const { file, path } of files) {
        if (worth.has(path)) continue
        const candidate: AvailableFile = {
          assetId: path, name: file.name, size: file.size, duration, quickHash: null,
        }
        if (prefilter(t.want!, candidate)) worth.set(path, duration)
      }
    }

    const total = worth.size
    const available: AvailableFile[] = []
    const unreadable: string[] = []
    let hashed = 0

    for (const { file, path } of files) {
      const duration = worth.get(path)
      if (duration === undefined) continue
      onProgress?.(hashed, total, file.name)
      const print = await fingerprintOf(file, duration)
      // A file that could not be hashed is not an error — it is a file that can
      // only ever be a proposal, and it is recorded so the count is honest.
      if (print.quickHash === null) unreadable.push(file.name)
      available.push({ assetId: path, name: file.name, size: file.size, duration, quickHash: print.quickHash })
      hashed += 1
    }
    onProgress?.(hashed, total, '')

    const items = planBatch(project, wanted, available)

    const attached: string[] = []
    for (const item of items) {
      // Hoisted, because a narrowed property does not survive into a callback
      // and `files.find` is one.
      const certain = item.certain
      if (!certain) continue
      const entry = files.find((f) => f.path === certain.file.assetId)
      if (!entry) continue
      // The same certainty rule as a single relink. Anything weaker is a
      // proposal below, and the user chose that those wait for them.
      const outcome = await relinkAsset(item.assetId, entry.file)
      if (outcome.ok) attached.push(item.name)
    }

    const proposals = items.filter((i) => i.certain === null && i.proposals.length > 0)
    return { attached, proposals, unreadable, hashed }
  }

  /** Apply one confirmed proposal, now that a person has said yes to it. */
  async function acceptProposal(
    assetId: string,
    file: File,
  ): Promise<{ ok: boolean; reason: string }> {
    // The fingerprint is gone for an asset that has already been settled, so a
    // proposal re-checked here would compare against nothing. It was checked
    // when the plan was made, against the folder; the confirmation is the only
    // thing missing, and pretending to re-verify would be theatre.
    return relinkAsset(assetId, file)
  }

  async function rename(next: string): Promise<void> {
    const trimmed = next.trim()
    if (!trimmed || trimmed === name()) return
    const wasDirty = saveState() === 'dirty'
    setName(trimmed)
    await renameProject(ensureId(), trimmed)
    // A rename is part of the project, so it is saved. Going through `saveNow`
    // rather than the debounce means the list is not briefly showing the old
    // name next to the new one.
    if (wasDirty) await saveNow()
    await refreshList()
  }

  /**
   * Copy the open project, media and all, and switch to the copy.
   *
   * The alternative — two names pointing at one set of bytes — is the
   * reference-counting trap: delete either and the other loses its media with no
   * warning. Duplicating a project is rare enough that the disk is cheaper than
   * the bug.
   */
  async function duplicate(): Promise<string | null> {
    const source = id()
    if (!source) return null
    await saveNow()
    const fresh = newId('prj')
    const label = name()
    await createProject(fresh, `${label} copy`, deps.read())
    const files = await copyMedia(source, fresh)
    log.info(`persistence: duplicated ${label} with ${files} media file(s)`)
    await refreshList()
    deps.notify('info', `Duplicated “${label}” — ${files} file(s) copied. Open it from the project list.`)
    return fresh
  }

  async function remove(targetId: string): Promise<void> {
    await deleteProject(targetId)
    if (id() === targetId) {
      // Forget the id *before* starting new. `startNew` saves the current
      // project first, and with the id still pointing at the record we just
      // deleted, that save would recreate it — the project reappearing after
      // you delete it. A null id means there is nothing to save.
      setId(null)
      await startNew()
    }
    await refreshList()
  }

  async function refreshList(): Promise<void> {
    setProjects(await listProjects())
  }

  async function refreshUsage(): Promise<void> {
    setUsage(await storageUsage())
  }

  /**
   * Drop the bytes of assets no longer in the project.
   *
   * Removing a *clip* leaves its asset — the bin still lists it, and the user may
   * want it back. Removing the asset from the project is the point where the
   * bytes go, or a delete-and-reimport cycle leaks a copy every time.
   */
  async function pruneUnusedMedia(): Promise<number> {
    const projectId = id()
    if (!projectId) return 0
    return pruneMedia(projectId, Object.keys(deps.read().assets))
  }

  // --- portable files ----------------------------------------------------

  /**
   * The media descriptions to go in an exported file.
   *
   * Fingerprinted here, at export time, from the files we still hold — so
   * nothing has to be stored between import and export, and a fingerprint is
   * never stale. The cost is one megabyte read per asset, once, when the user
   * asks for it.
   */
  async function gatherMedia(): Promise<Record<string, ExportedMedia>> {
    const project = deps.read()
    const out: Record<string, ExportedMedia> = {}
    for (const [assetId, asset] of Object.entries(project.assets)) {
      const file = deps.fileFor(assetId)
      if (!file) continue // an asset with no file has nothing to describe
      const fingerprint = await fingerprintOf(file, asset.duration)
      out[assetId] = {
        size: fingerprint.size,
        duration: fingerprint.duration,
        quickHash: fingerprint.quickHash,
      }
    }
    return out
  }

  /** The JSON for the open project, ready to write to disk. */
  async function exportText(): Promise<string> {
    await saveNow()
    const project = deps.read()
    return buildProjectFile(project, await gatherMedia(), {
      playhead: deps.playhead(),
      selection: [...deps.selected()],
      name: name(),
    })
  }

  /** A filename that says what and when, since the OS sorts alphabetically. */
  function exportFilename(): string {
    const base = name().replace(/[^a-z0-9 _-]/gi, '').trim() || 'project'
    const d = new Date()
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    return `${base} ${stamp}.json`
  }

  /** What an import found, so the UI can be honest about it. */
  interface ImportReport {
    projectName: string
    clipCount: number
    /** Assets attached to a file we already held, and on what evidence. */
    attached: { name: string; how: string }[]
    /** Assets with no media. Normal on a new machine, and the common case. */
    missing: string[]
    /**
     * Files that came close, and were **not** attached.
     *
     * Kept even though the decision is already made, because a near-miss is
     * information and throwing it away means stage 2 has to fingerprint
     * everything a second time to rediscover it. Each entry says why it was
     * rejected, so the UI can show the difference between "nothing in common"
     * and "same name and size, but the content differs" — the second is worth a
     * human's attention and the first is not.
     */
    rejected: { name: string; reason: string }[]
  }

  /**
   * Import a project file, attaching any media we already hold.
   *
   * The media that *is* found gets attached by fingerprint, and only on a
   * certain match. Everything else is imported as a clip with no media behind
   * it, which the app already handles gracefully: the clip keeps its name and
   * length, the timeline draws it, and the preview says the media is missing.
   *
   * The edit is the irreplaceable part, so it opens either way. Refusing would
   * throw away work to avoid a message.
   */
  async function importText(text: string): Promise<ImportReport> {
    const imported = parseProjectFile(text)

    // Fingerprint everything currently in the library once, then match against
    // it. Re-hashing per asset would read the same megabyte N times.
    const available: { assetId: string; name: string; size: number; duration: number; quickHash: string | null }[] = []
    for (const [assetId, asset] of Object.entries(deps.read().assets)) {
      const file = deps.fileFor(assetId)
      if (!file) continue
      available.push({
        assetId,
        name: asset.name,
        size: file.size,
        duration: asset.duration,
        quickHash: await quickHashOf(file),
      })
    }

    const attached: { name: string; how: string }[] = []
    const missing: string[] = []
    const taken = new Set<string>()
    const rejected: { name: string; reason: string }[] = []
    /** Files to re-add under the *imported* asset ids, once the old library is gone. */
    const matched: { file: File; assetId: string; name: string }[] = []

    for (const [assetId, asset] of Object.entries(imported.project.assets)) {
      const want = fingerprintFor(imported.media, assetId)
      const candidates = want
        ? available.filter((c) => !taken.has(c.assetId) && matchFingerprint(want, c, asset.name, c.name).kind !== 'none')
        : []

      // Only a *certain* match is applied. Everything else is reported, because
      // a confidently wrong attachment produces an export that looks right and
      // is not.
      const certain = candidates.find((c) => want && isCertain(matchFingerprint(want, c, asset.name, c.name)))

      // A near-miss is recorded but never applied. Recording it is not
      // second-guessing the decision: the decision stands, and the reason travels
      // with the report so the next screen can explain itself.
      if (!certain && candidates.length > 0) {
        for (const c of candidates) {
          const m = want ? matchFingerprint(want, c, asset.name, c.name) : { kind: 'none' as const, reason: 'no fingerprint recorded' }
          rejected.push({ name: asset.name, reason: m.reason })
        }
      }

      if (certain && want) {
        const file = deps.fileFor(certain.assetId)
        if (file) {
          // Held as a `File`, not attached now. The library is emptied a few
          // lines below, so attaching first and releasing after would throw the
          // attachment away again — which is exactly what it did: the edit came
          // back with no media even though the file was sitting right there.
          matched.push({ file, assetId, name: asset.name })
        }
        taken.add(certain.assetId)
        attached.push({ name: asset.name, how: 'identical' })
        continue
      }
      missing.push(asset.name)
    }

    const label = imported.name
    const fresh = newId('prj')
    await createProject(fresh, label, imported.project)
    // Empty the old library, then put the matched files back *under the imported
    // asset ids*, and only then write the project. That order matters twice
    // over: the library is not reactive, so the media bin's rows would otherwise
    // be created against an empty library and never update.
    deps.releaseLibrary()
    for (const hit of matched) await deps.restoreFile(hit.file, hit.assetId, hit.name)
    setId(fresh)
    setName(label)
    setMissing([])
    // The fingerprints describe the files this project was cut with, which are
    // almost never on this machine. Keeping them is what lets the review screen
    // say *why* a file was not attached, and what lets a relink (single or from
    // a folder) verify the file a person picks. Without this the map stays empty
    // and every relink is accepted unverified.
    setWantedFingerprints(imported.media)
    lastSavedJson = serialiseProject(imported.project)
    setSaveState('saved')
    deps.write(imported.project)
    if (imported.selection.length > 0) deps.select(imported.selection)
    deps.seek(imported.playhead)
    await persistLastOpen(fresh)
    await refreshList()

    if (!hashingAvailable()) {
      deps.notify(
        'warn',
        'This browser will not let the app check file contents, so media was matched by name and size only.',
      )
    }
    return {
      projectName: label,
      clipCount: imported.project.video.length + imported.project.audio.length,
      attached,
      missing,
      rejected,
    }
  }

  async function quickHashOf(file: Blob): Promise<string | null> {
    const { quickHash } = await import('./fingerprint.js')
    return quickHash(file)
  }

  /** Media ids stored for this project, for diagnostics and tests. */
  async function storedMediaIds(): Promise<string[]> {
    const projectId = id()
    return projectId ? mediaIds(projectId) : []
  }

  function fileForStored(assetId: string): File | null {
    return deps.fileFor(assetId)
  }

  return {
    id,
    name,
    saveState,
    projects,
    missing,
    usage,
    storageError,
    markDirty,
    saveNow,
    boot,
    open,
    startNew,
    rename,
    duplicate,
    remove,
    refreshList,
    refreshUsage,
    rememberMedia,
    wantedFingerprints,
    setWantedFingerprints,
    mediaStatus,
    relinkAsset,
    relinkFromFolder,
    acceptProposal,
    exportText,
    exportFilename,
    importText,
    pruneUnusedMedia,
    storedMediaIds,
    fileForStored,
    // Exposed for the load path, which needs to swap the project wholesale.
    setId,
  }
}

function guessMime(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  const known: Record<string, string> = {
    mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
    mkv: 'video/x-matroska', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac',
    wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/opus',
  }
  return known[ext] ?? ''
}

export type ProjectStore = ReturnType<typeof createProjectStore>
