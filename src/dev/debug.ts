/**
 * Debug logging that also streams to the dev-server terminal.
 *
 * "Send me the console output" is a terrible debugging loop. This forwards
 * everything to a Vite endpoint that prints server-side, so the browser's
 * messages land in the same terminal as `npm run dev`.
 *
 * Every log is kept in a ring buffer too, so the whole session's history can be
 * dumped in one click from the page — which is the part that actually helps
 * when the bug only reproduces on the fifth playhead move.
 */

import { createSignal } from 'solid-js'

const ENDPOINT = '/__debug'
const BUFFER_LIMIT = 400

/**
 * A counter bumped on every log, so a view can render the history reactively.
 *
 * The buffer itself is a plain array, which is right for a hot path — logging
 * must never make the app re-render on its own. Exposing a revision counter
 * instead of a signal of entries means a component opts in to the cost, and a
 * closed log panel costs nothing.
 */
const [revision, setRevision] = createSignal(0)

export type Level = 'debug' | 'info' | 'warn' | 'error'

export interface DebugLog {
  level: Level
  message: string
  data?: unknown
  time: number
  tag: string
}

const buffer: DebugLog[] = []
let currentTag = 'app'

/** Group subsequent logs under a label, so a trace reads as a story. */
export function tag(name: string): () => void {
  const previous = currentTag
  currentTag = name
  return () => {
    currentTag = previous
  }
}

function serialize(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ''}`
  if (typeof value === 'string') return value
  if (value === undefined) return 'undefined'

  if (value === null) return 'null'

  // Cycles and DOM nodes are the two things that turn a debug log into noise.
  const seen = new WeakSet<object>()
  try {
    return JSON.stringify(
      value,
      (_key, val) => {
        if (typeof val === 'object' && val !== null) {
          if (seen.has(val)) return '[circular]'
          seen.add(val)
          if (val instanceof HTMLElement) return `<${val.tagName.toLowerCase()}>`
          if (typeof (val as { width?: unknown }).width === 'number' && 'getContext' in val) {
            return `canvas ${(val as { width: number }).width}x${(val as { height: number }).height}`
          }
        }
        return val
      },
      2,
    ) ?? String(value)
  } catch {
    return String(value)
  }
}

function emit(level: Level, message: string, data?: unknown): void {
  const entry: DebugLog = { level, message, data, time: Date.now(), tag: currentTag }
  buffer.push(entry)
  if (buffer.length > BUFFER_LIMIT) buffer.shift()
  setRevision((n) => n + 1)

  const line = `[${entry.tag}] ${message}`

  if (level === 'error') console.error(line, data ?? '')
  else if (level === 'warn') console.warn(line, data ?? '')
  else if (level === 'debug') console.debug(line, data ?? '')
  else console.log(line, data ?? '')

  // Development only, and only in a browser. The logger is imported by modules
  // under unit test, where there is no `location` — a logger that throws when
  // nobody asked it to log is worse than no logger.
  if (isLocalhost()) {
    post(JSON.stringify({ level, message, data: safe(data), time: entry.time, tag: entry.tag }))
  }
}

/** True in a dev browser, false anywhere else including Node. */
function isLocalhost(): boolean {
  try {
    if (typeof location === 'undefined') return false
    return location.hostname === 'localhost' || location.hostname === '127.0.0.1'
  } catch {
    return false
  }
}

function post(payload: string): void {
  try {
    if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
      navigator.sendBeacon(ENDPOINT, new Blob([payload], { type: 'application/json' }))
      return
    }
    if (typeof fetch === 'function') {
      void fetch(ENDPOINT, { method: 'POST', body: payload, keepalive: true }).catch(() => undefined)
    }
  } catch {
    /* the terminal is a convenience, never a dependency */
  }
}

/** Serialise defensively — a logger must never throw. */
function safe(value: unknown): unknown {
  try {
    return value === undefined ? null : JSON.parse(serialize(value))
  } catch {
    return String(value)
  }
}

export const log = {
  debug: (message: string, data?: unknown) => emit('debug', message, data),
  info: (message: string, data?: unknown) => emit('info', message, data),
  warn: (message: string, data?: unknown) => emit('warn', message, data),
  error: (message: string, data?: unknown) => emit('error', message, data),
}

export function history(): DebugLog[] {
  return buffer.slice()
}

/**
 * Read this to re-render when the history changes. Not the array — the array is
 * a fresh slice on every call, so depending on it would re-render forever.
 */
export function logRevision(): number {
  return revision()
}

export function dump(): string {
  return buffer.map((e) => `[${new Date(e.time).toISOString().slice(11, 23)}] [${e.tag}/${e.level}] ${e.message}${e.data === undefined ? '' : ` ${serialize(e.data)}`}`).join('\n')
}

export function clear(): void {
  buffer.length = 0
  setRevision((n) => n + 1)
}

/**
 * Mirror the browser's *own* console into the terminal, so a stack trace from
 * inside a dependency shows up without anyone copying it by hand.
 */
export function install(): void {
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      original(...args)
      if (args.length && !String(args[0]).startsWith('[')) {
        // Avoid recursing: emit() calls the console.
        if (isLocalhost()) {
          post(JSON.stringify({ level, message: args.map(serialize).join(' '), time: Date.now(), tag: 'console' }))
        }
      }
    }
  }
  window.addEventListener('error', (e) => log.error(`uncaught: ${e.message}`, { source: e.filename, line: e.lineno }))
  window.addEventListener('unhandledrejection', (e) => log.error(`unhandled rejection: ${serialize(e.reason)}`))
}
