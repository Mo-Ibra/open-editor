/**
 * Single source of truth for the source paths that structural (dom) tests read.
 *
 * These tests assert on the *text* of view modules, so they reference files by
 * exact path. When a module is moved (see REFACTOR-VIEW.md), every hard-coded
 * string would otherwise need updating by hand. Keeping the paths in one map
 * means a move touches this file and nothing else in the test suite.
 *
 * Paths are relative to the repo root. Update them when you move a module.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const VIEW = {
  app: 'src/app/view/App.tsx',
  assetBin: 'src/app/view/media/AssetBin.tsx',
  mediaPanel: 'src/app/view/media/MediaPanel.tsx',
  projectPanel: 'src/app/view/projects/ProjectPanel.tsx',
  contextMenu: 'src/app/view/ui/ContextMenu.tsx',
  fullscreen: 'src/app/view/shell/fullscreen.ts',
  resizer: 'src/app/view/shell/Resizer.tsx',
  transfer: 'src/app/view/projects/transfer.ts',
  folder: 'src/app/view/media/folder.ts',
  preview: 'src/app/view/preview/Preview.tsx',
  timeline: 'src/app/view/timeline/Timeline.tsx',
  drag: 'src/app/view/timeline/use-timeline-drag.ts',
  clip: 'src/app/view/timeline/Clip.tsx',
  lane: 'src/app/view/timeline/Lane.tsx',
  toolbar: 'src/app/view/timeline/Toolbar.tsx',
  dropCue: 'src/app/view/timeline/DropCue.tsx',
  ruler: 'src/app/view/timeline/Ruler.tsx',
  transport: 'src/app/view/preview/Transport.tsx',
  paintIntent: 'src/app/view/preview/paint-intent.ts',
} as const

export type ViewKey = keyof typeof VIEW

/** Repo-root-relative path for a view module key. */
export function viewPath(key: ViewKey): string {
  return VIEW[key]
}

/** Resolve a repo-root-relative path to an absolute filesystem path. */
export function repoPath(rel: string): string {
  return join(repoRootFor(), rel)
}

/** Read a view module's source text by its key in the VIEW map. */
export function readView(key: ViewKey): string {
  return readFileSync(repoPath(VIEW[key]), 'utf8')
}

/** Read an arbitrary repo-root-relative file's source text. */
export function readRepoFile(rel: string): string {
  return readFileSync(repoPath(rel), 'utf8')
}

function repoRootFor(): string {
  return new URL('..', import.meta.url).pathname
}