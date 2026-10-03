/**
 * Project persistence.
 *
 * **A project is two things, and only two.** The edit — lanes, clips, assets
 * metadata — which is a few kilobytes of JSON and is pure data. And the source
 * media, which is not small and is not derivable: a `File` is an OS handle, so
 * after a reload nothing can find those bytes again. A saved path would be
 * useless, because the web platform cannot reopen a file by path. So the bytes
 * are copied into browser storage, and that is the trade this module makes.
 *
 * Consequently a project costs roughly as much disk as its media. That is
 * `usage()`'s job to make visible, and the quota's job to refuse cleanly.
 *
 * Three stores:
 *
 * - `projects` — one record per project: `{id, name, created, updated, json}`.
 * - `blobs` — the raw bytes, keyed `[projectId, assetId]`. Written **once**, at
 *   import, and never rewritten. That is what makes autosave affordable: a save
 *   is a few KB of JSON, not a gigabyte of video.
 * - `meta` — single values, currently "which project was open".
 *
 * Blobs are keyed per project rather than by content hash. Deduplicating would
 * save space when the same file is used twice, but it needs reference counting,
 * and a wrong reference count silently deletes somebody's footage. Boring and
 * correct beats clever here.
 *
 * **No mediabunny and no DOM in this file.** Rebuilding decoders is the store's
 * job, not storage's, which is what keeps this layer testable and this file
 * small.
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import { log } from '../../dev/debug.js'
import { migrateProject, serialiseProject, type StoredProject } from './project-format.js'
import type { Project } from '../../model/project.js'

const DB_NAME = 'open-editor'
const DB_VERSION = 1

interface Schema extends DBSchema {
  projects: {
    key: string
    value: StoredProject
    indexes: { 'by-updated': number }
  }
  blobs: {
    key: [string, string]
    value: { projectId: string; assetId: string; blob: Blob }
  }
  meta: {
    key: string
    value: { key: string; value: string }
  }
}

export interface ProjectSummary {
  id: string
  name: string
  created: number
  updated: number
  clipCount: number
  /** Bytes of media this project holds. */
  mediaBytes: number
}

export interface LoadedProject {
  id: string
  name: string
  /** Always present: a project that cannot be parsed is an error, not a load. */
  json: string
}

export interface StorageUsage {
  used: number
  quota: number
  /**
   * Whether the browser has agreed to keep this. `false` means the origin is
   * evictable, which is the difference between "saved" and "saved until the
   * disk fills up".
   */
  persisted: boolean
}

const LAST_OPEN = 'last-opened'

function db(): Promise<IDBPDatabase<Schema>> {
  return openDB<Schema>(DB_NAME, DB_VERSION, {
    upgrade(database) {
      const projects = database.createObjectStore('projects', { keyPath: 'id' })
      projects.createIndex('by-updated', 'updated')
      database.createObjectStore('blobs', { keyPath: ['projectId', 'assetId'] })
      database.createObjectStore('meta', { keyPath: 'key' })
    },
    blocked() {
      // Another tab is holding the old version open. Saving will fail until it
      // closes, so say so rather than letting the write vanish.
      log.warn('persistence: upgrade blocked by another tab')
    },
  })
}

/**
 * Open the database, reporting a real failure.
 *
 * Private browsing, a disabled store, or a corrupted origin all reject the
 * open. Swallowing that would leave the app *appearing* to autosave while
 * writing nothing, which is the worst possible failure for a feature whose whole
 * job is not losing work.
 */
export async function openProjectDb(): Promise<IDBPDatabase<Schema> | null> {
  try {
    return await db()
  } catch (err) {
    log.error('persistence: storage unavailable', String(err))
    return null
  }
}

/** Every project, most recently updated first. */
export async function listProjects(): Promise<ProjectSummary[]> {
  const database = await openProjectDb()
  if (!database) return []
  const all = await database.getAll('projects')
  const out: ProjectSummary[] = []
  for (const record of all) {
    out.push({
      id: record.id,
      name: record.name,
      created: record.created,
      updated: record.updated,
      clipCount: countClips(record.json),
      mediaBytes: 0,
    })
  }
  // Storage per project is a cursor over its blobs, which is a full scan. Only
  // worth it for a list the user is actually looking at.
  for (const summary of out) {
    summary.mediaBytes = await mediaBytes(database, summary.id)
  }
  return out.sort((a, b) => b.updated - a.updated)
}

function countClips(json: string): number {
  try {
    const parsed = JSON.parse(json) as { video?: unknown[]; audio?: unknown[] }
    return (parsed.video?.length ?? 0) + (parsed.audio?.length ?? 0)
  } catch {
    return 0
  }
}

async function mediaBytes(database: IDBPDatabase<Schema>, projectId: string): Promise<number> {
  let total = 0
  // The key is `[projectId, assetId]`, so a range bounded by `[projectId, '']`
  // and `[projectId, '\uffff']` is exactly this project's blobs and nothing
  // else. Passing the bare array key here opened a cursor on a key that does not
  // exist, so every project reported 0 bytes of media.
  const range = IDBKeyRange.bound([projectId, ''], [projectId, '\uffff'])
  let cursor = await database.transaction('blobs').store.openCursor(range)
  while (cursor) {
    total += cursor.value.blob.size ?? 0
    cursor = await cursor.continue()
  }
  return total
}

/** A new project record. The id is the caller's, so it can be a stable slug. */
export async function createProject(id: string, name: string, project: Project): Promise<void> {
  const database = await openProjectDb()
  if (!database) return
  const now = Date.now()
  await database.put('projects', {
    id,
    name,
    created: now,
    updated: now,
    // Serialised now, so a project that cannot be written is reported here
    // rather than on the first autosave seconds later.
    json: serialiseProject(project),
  })
}

/** Write the edit. Cheap enough to call on every change. */
export async function saveProject(id: string, project: Project, name?: string): Promise<void> {
  const database = await openProjectDb()
  if (!database) return
  const existing = await database.get('projects', id)
  if (!existing) {
    await createProject(id, name ?? 'Untitled', project)
    return
  }
  await database.put('projects', {
    ...existing,
    ...(name ? { name } : {}),
    updated: Date.now(),
    json: serialiseProject(project),
  })
}

export async function loadProject(id: string): Promise<LoadedProject | null> {
  const database = await openProjectDb()
  if (!database) return null
  const record = await database.get('projects', id)
  if (!record) return null
  // Parsed and migrated on the way out, so a corrupt or stale file is an error
  // the caller can show rather than a broken project on screen.
  migrateProject(record.json)
  return { id: record.id, name: record.name, json: record.json }
}

export async function renameProject(id: string, name: string): Promise<void> {
  const database = await openProjectDb()
  if (!database) return
  const record = await database.get('projects', id)
  if (!record) return
  await database.put('projects', { ...record, name, updated: Date.now() })
}

/**
 * Delete a project *and its media*.
 *
 * One transaction, so a failure cannot leave the bytes behind with nothing
 * pointing at them. A blob store that outlives its project is a silent disk
 * leak, and users do delete projects.
 */
export async function deleteProject(id: string): Promise<void> {
  const database = await openProjectDb()
  if (!database) return
  const tx = database.transaction(['projects', 'blobs'], 'readwrite')
  await tx.objectStore('projects').delete(id)
  await tx.objectStore('blobs').delete(IDBKeyRange.bound([id, ''], [id, '￿']))
  await tx.done
}

/** Store one asset's bytes. Written once, at import. */
export async function putMedia(projectId: string, assetId: string, blob: Blob): Promise<void> {
  const database = await openProjectDb()
  if (!database) return
  await database.put('blobs', { projectId, assetId, blob })
}

export async function getMedia(projectId: string, assetId: string): Promise<Blob | null> {
  const database = await openProjectDb()
  if (!database) return null
  const record = await database.get('blobs', [projectId, assetId])
  return record?.blob ?? null
}

/** Every asset id this project has bytes for. */
export async function mediaIds(projectId: string): Promise<string[]> {
  const database = await openProjectDb()
  if (!database) return []
  const keys = await database.getAllKeys('blobs', IDBKeyRange.bound([projectId, ''], [projectId, '￿']))
  return keys.map((k) => (k as [string, string])[1])
}

/**
 * Drop media no clip references.
 *
 * Removing a clip does not remove the asset — the bin still lists it, and the
 * user may put it back. But once the asset leaves the *project* entirely, its
 * bytes should go, or deleting a project and re-importing leaks a copy each
 * time.
 */
export async function pruneMedia(projectId: string, keep: Iterable<string>): Promise<number> {
  const database = await openProjectDb()
  if (!database) return 0
  const wanted = new Set(keep)
  const stored = await mediaIds(projectId)
  const doomed = stored.filter((assetId) => !wanted.has(assetId))
  if (doomed.length === 0) return 0
  const tx = database.transaction('blobs', 'readwrite')
  for (const assetId of doomed) await tx.store.delete([projectId, assetId])
  await tx.done
  log.info(`persistence: pruned ${doomed.length} unused media file(s)`)
  return doomed.length
}

/**
 * Copy one project's media onto another.
 *
 * For "duplicate": the copy is a *real* project, so it needs its own bytes. The
 * alternative — pointing both at one blob — is the reference-counting trap
 * [ADR-10](../docs/decisions/0010-copy-media-and-reopen-what-you-can.md), and it
 * is not worth the disk for a button people press occasionally.
 */
export async function copyMedia(fromProjectId: string, toProjectId: string): Promise<number> {
  const database = await openProjectDb()
  if (!database) return 0
  const source = await database.getAll('blobs', IDBKeyRange.bound([fromProjectId, ''], [fromProjectId, '\uffff']))
  if (source.length === 0) return 0
  const tx = database.transaction('blobs', 'readwrite')
  for (const record of source) {
    await tx.store.put({ projectId: toProjectId, assetId: record.assetId, blob: record.blob })
  }
  await tx.done
  log.info(`persistence: copied ${source.length} media file(s) to ${toProjectId}`)
  return source.length
}

export async function getMeta(key: string): Promise<string | null> {
  const database = await openProjectDb()
  if (!database) return null
  const value = (await database.get('meta', key))?.value ?? null
  log.debug('persistence: meta read', { key, value })
  return value
}

export async function setMeta(key: string, value: string): Promise<void> {
  const database = await openProjectDb()
  if (!database) {
    log.warn('persistence: setMeta with no database', key)
    return
  }
  await database.put('meta', { key, value })
  // Written, *then* confirmed by reading it back. A `put` that resolves has
  // committed the request, but "the pointer to the open project is saved" is a
  // promise the whole app makes, and a silent no-op here is invisible until a
  // reload comes back empty.
  const back = await database.get('meta', key)
  if (back?.value !== value) log.error('persistence: setMeta did not stick', { key, want: value, got: back?.value })
  else log.debug('persistence: meta written', { key })
}

export { LAST_OPEN }

/**
 * How much storage this origin is using, and whether it is safe.
 *
 * `persisted: false` is the one that matters. Without it the browser may evict
 * everything under disk pressure, and a project that silently vanishes is worse
 * than one that was never saved — so the UI has to be able to say so.
 */
export async function storageUsage(): Promise<StorageUsage> {
  try {
    const estimate = await navigator.storage?.estimate?.()
    const persisted = (await navigator.storage?.persisted?.()) ?? false
    return {
      used: estimate?.usage ?? 0,
      quota: estimate?.quota ?? 0,
      persisted,
    }
  } catch (err) {
    log.warn('persistence: usage unavailable', String(err))
    return { used: 0, quota: 0, persisted: false }
  }
}

/** Ask the browser to stop evicting us. Best-effort, and often a no-op. */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (await navigator.storage?.persisted?.()) return true
    return (await navigator.storage?.persist?.()) ?? false
  } catch {
    return false
  }
}
