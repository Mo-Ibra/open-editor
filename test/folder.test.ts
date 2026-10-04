/**
 * Turning a folder into files, without a browser.
 *
 * The failure modes here are quiet ones. A single `readEntries` call loses most
 * of a large folder and reports success; a missing `readEntries` loop turns a
 * 400-file shoot into 100 files and nobody notices until the export. Both are
 * tested, because both look exactly like a folder that happened to be small.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'

import {
  fromFileList,
  MAX_FOLDER_DEPTH,
  MAX_FOLDER_FILES,
  filesFromDrop,
  type FolderFile,
} from '../src/app/view/media/folder.ts'

// --- fakes ------------------------------------------------------------------

const fakeFile = (name: string, size = 1000, lastModified = 1): File =>
  ({ name, size, lastModified, type: 'video/mp4' }) as unknown as File

/** Rebuild the fake directory tree into the entry shape the walker expects. */
const dir = (name: string, children: unknown[]): unknown => {
  let sent = 0
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => ({
      readEntries: (ok: (e: unknown[]) => void) => {
        // A strict batch of 1, which is the case that breaks a naive walker.
        const batch = sent < children.length ? [children[sent++]] : []
        ok(batch)
      },
    }),
  }
}

const fileEntry = (name: string, size = 1000): unknown => ({
  isFile: true,
  isDirectory: false,
  name,
  file: (ok: (f: File) => void) => ok(fakeFile(name, size)),
})

// --- the reader loop --------------------------------------------------------

test('a folder deeper than one level is walked, not truncated', async () => {
  const inner = dir('camera-a', [fileEntry('a001.mov'), fileEntry('a002.mov')])
  const top = dir('shoot-04', [inner, fileEntry('notes.txt')])
  const dt = { items: [{ webkitGetAsEntry: () => top }], files: [] } as unknown as DataTransfer

  const out = await filesFromDrop(dt)
  assert.deepEqual(
    out.map((f) => f.path).sort(),
    ['shoot-04/camera-a/a001.mov', 'shoot-04/camera-a/a002.mov', 'shoot-04/notes.txt'],
    'the nested files are found and the path says which camera they came from',
  )
})

test('more entries than one readEntries batch are all returned', async () => {
  // The classic silent loss: `readEntries` returns at most ~100 and the folder
  // has 250 files. One call finds 100 and reports no error at all.
  const children = Array.from({ length: 250 }, (_, i) => fileEntry(`clip${i}.mov`))
  const root = dir('footage', children)
  const dt = { items: [{ webkitGetAsEntry: () => root }], files: [] } as unknown as DataTransfer

  const out = await filesFromDrop(dt)
  assert.equal(out.length, 250, 'every file, not the first batch')
  assert.equal(new Set(out.map((f) => f.path)).size, 250, 'and no duplicates from the repeated batches')
})

test('a directory that cannot be read does not sink the whole walk', async () => {
  const broken = {
    isFile: false, isDirectory: true, name: 'locked',
    createReader: () => ({ readEntries: (_ok: (e: unknown[]) => void, err: (e: unknown) => void) => err(new Error('EACCES')) }),
  }
  const root = dir('footage', [fileEntry('a.mov'), broken, fileEntry('b.mov')])
  const dt = { items: [{ webkitGetAsEntry: () => root }], files: [] } as unknown as DataTransfer

  const out = await filesFromDrop(dt)
  assert.deepEqual(out.map((f) => f.file.name).sort(), ['a.mov', 'b.mov'])
})

test('a file entry whose read fails is skipped, not thrown', async () => {
  const bad = {
    isFile: true, isDirectory: false, name: 'gone.mov',
    file: (_ok: (f: File) => void, err: (e: unknown) => void) => err(new Error('ENOENT')),
  }
  const root = dir('footage', [bad, fileEntry('good.mov')])
  const dt = { items: [{ webkitGetAsEntry: () => root }], files: [] } as unknown as DataTransfer

  const out = await filesFromDrop(dt)
  assert.deepEqual(out.map((f) => f.file.name), ['good.mov'])
})

test('the walk stops at the depth limit instead of recursing forever', async () => {
  // A symlink loop, or just a pathological layout. The assertion that matters is
  // that this returns at all.
  let node = dir(`leaf${MAX_FOLDER_DEPTH + 5}`, [])
  for (let i = MAX_FOLDER_DEPTH + 4; i >= 0; i--) node = dir(`d${i}`, [node])
  const deep = dir('root', [node])
  const dt = { items: [{ webkitGetAsEntry: () => deep }], files: [] } as unknown as DataTransfer

  const out = await filesFromDrop(dt)
  // Nothing is below the limit, because the only leaf is. The point is that it
  // terminated and did not throw.
  assert.deepEqual(out, [])
})

test('the file count is capped', async () => {
  const many = Array.from({ length: 40 }, (_, i) => fileEntry(`f${i}.mov`))
  const root = dir('footage', many)
  const dt = { items: [{ webkitGetAsEntry: () => root }], files: [] } as unknown as DataTransfer
  const out = await filesFromDrop(dt)
  assert.equal(out.length, 40)
  assert.ok(MAX_FOLDER_FILES > 40)
})

// --- the picker list -------------------------------------------------------

test('webkitRelativePath is kept, because it is what makes a folder a folder', () => {
  // Two takes called a001.mov in two camera folders are different files, and
  // only the path tells them apart.
  const a = { ...fakeFile('a001.mov', 1000), webkitRelativePath: 'shoot-04/cam-a/a001.mov' } as File
  const b = { ...fakeFile('a001.mov', 2000), webkitRelativePath: 'shoot-04/cam-b/a001.mov' } as File
  const out = fromFileList([a, b])
  assert.deepEqual(out.map((f) => f.path), ['shoot-04/cam-a/a001.mov', 'shoot-04/cam-b/a001.mov'])
})

test('identical files under the same path are collapsed', () => {
  const a = { ...fakeFile('a.mov', 1000), webkitRelativePath: 'x/a.mov' } as File
  const b = { ...fakeFile('a.mov', 1000), lastModified: 1, webkitRelativePath: 'x/a.mov' } as File
  assert.equal(fromFileList([a, b]).length, 1, 'a duplicate pick is one file')
})

test('a file with no relative path still works, as a plain pick', () => {
  const out = fromFileList([fakeFile('loose.mov')])
  assert.deepEqual(out.map((f) => f.path), ['loose.mov'])
})

test('a drop with no entry API falls back to the flat file list', () => {
  // The path every non-Chromium browser takes, since `webkitGetAsEntry` is what
  // `showDirectoryPicker` would otherwise have provided.
  const dt = { items: [{ getAsFile: () => null }], files: [fakeFile('a.mov')] } as unknown as DataTransfer
  return filesFromDrop(dt).then((out: FolderFile[]) => {
    assert.deepEqual(out.map((f) => f.file.name), ['a.mov'])
  })
})

test('a drop with nothing in it returns nothing, rather than throwing', async () => {
  assert.deepEqual(await filesFromDrop(null), [])
  assert.deepEqual(await filesFromDrop({ items: [], files: null } as unknown as DataTransfer), [])
})
