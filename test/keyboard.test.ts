/**
 * Shortcut matching, and the legend's inability to drift.
 *
 * The bug this exists for: the status-bar legend used to be a hand-written
 * array next to the key handler, and it advertised `D — overlay` with no
 * handler behind it. A legend entry describing nothing is valid TypeScript and
 * renders perfectly, so nothing catches it.
 *
 * The arrangement now is that `shortcutLegend` is *derived* from the shortcut
 * list, so the drift is structurally impossible. These tests pin that, and pin
 * the matching rules that make it safe to declare both `z` and `⇧⌘z`.
 */

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { matchShortcut, shouldIgnore, shortcutLegend, type Shortcut } from '../src/app/commands/keyboard.ts'

const pressed = (key: string, mods: Partial<KeyboardEvent> = {}): KeyboardEvent =>
  ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, target: null, ...mods }) as unknown as KeyboardEvent

const S = (
  keys: string[],
  hint: string,
  extra: Partial<Shortcut> = {},
): Shortcut => ({ keys, hint, label: hint, run: () => undefined, ...extra })

test('a plain key matches a shortcut with no modifiers', () => {
  const list = [S(['g'], 'G')]
  assert.equal(matchShortcut(list, pressed('g'))?.hint, 'G')
})

test('uppercase letters are normalised', () => {
  const list = [S(['g'], 'G')]
  assert.equal(matchShortcut(list, pressed('G'))?.hint, 'G')
})

test('an accel shortcut does not fire without the modifier', () => {
  const list = [S(['d'], '⌘D', { accel: true })]
  assert.equal(matchShortcut(list, pressed('d')), null)
  assert.equal(matchShortcut(list, pressed('d', { metaKey: true }))?.hint, '⌘D')
})

test('ctrl and meta are both accepted for accel', () => {
  const list = [S(['d'], '⌘D', { accel: true })]
  assert.equal(matchShortcut(list, pressed('d', { ctrlKey: true }))?.hint, '⌘D')
  assert.equal(matchShortcut(list, pressed('d', { metaKey: true }))?.hint, '⌘D')
})

test('a non-accel shortcut does not fire when the modifier is held', () => {
  // Otherwise ctrl+G would toggle snapping, which is not what anyone expects.
  const list = [S(['g'], 'G')]
  assert.equal(matchShortcut(list, pressed('g', { metaKey: true })), null)
})

test('undo and redo coexist on the same key', () => {
  const list = [
    S(['z'], '⌘Z', { accel: true }),
    S(['z'], '⇧⌘Z', { accel: true, shift: true }),
  ]
  assert.equal(matchShortcut(list, pressed('z', { metaKey: true }))?.hint, '⌘Z')
  assert.equal(matchShortcut(list, pressed('z', { metaKey: true, shiftKey: true }))?.hint, '⇧⌘Z')
})

test('a bare shift does not trigger the unshifted binding', () => {
  const list = [S(['ArrowLeft'], '←'), S(['ArrowLeft'], '⇧←', { shift: true })]
  assert.equal(matchShortcut(list, pressed('ArrowLeft'))?.hint, '←')
  assert.equal(matchShortcut(list, pressed('ArrowLeft', { shiftKey: true }))?.hint, '⇧←')
})

test('a disabled shortcut does not match', () => {
  const list = [S(['Backspace'], '⌫', { enabled: () => false })]
  assert.equal(matchShortcut(list, pressed('Backspace')), null)
})

test('an enabled shortcut matches', () => {
  const list = [S(['Backspace'], '⌫', { enabled: () => true })]
  assert.equal(matchShortcut(list, pressed('Backspace'))?.hint, '⌫')
})

test('gestures are never matched by a keypress', () => {
  // ^click and ⇧click are in the legend but have no `keys`, and must not be
  // reachable by pressing anything.
  const list = [S([], '^click', { gesture: true })]
  assert.equal(matchShortcut(list, pressed('^')), null)
  assert.equal(matchShortcut(list, pressed('c')), null)
})

test('first match wins, so declaration order is precedence', () => {
  const list = [S(['Backspace', 'Delete'], 'first'), S(['Delete'], 'second')]
  assert.equal(matchShortcut(list, pressed('Delete'))?.hint, 'first')
})

test('an unbound key matches nothing', () => {
  const list = [S(['g'], 'G')]
  assert.equal(matchShortcut(list, pressed('q')), null)
})

// --- the legend ------------------------------------------------------------

test('the legend is derived, so it cannot describe a missing shortcut', () => {
  const list = [S(['g'], 'G', { label: 'snap' }), S(['z'], '⌘Z', { accel: true, label: 'undo' })]
  const rows = shortcutLegend(list)
  assert.deepEqual(rows, [
    { hint: 'G', label: 'snap' },
    { hint: '⌘Z', label: 'undo' },
  ])
  // Every row must correspond to a shortcut that can actually fire.
  for (const row of rows) {
    const owner = list.find((s) => s.hint === row.hint)
    assert.ok(owner, `legend row "${row.hint}" has no shortcut`)
    assert.ok(owner.keys.length > 0 || owner.gesture, `"${row.hint}" can never fire`)
  }
})

test('adding a shortcut adds a legend row, and vice versa', () => {
  // The property the old hand-written list could not have.
  const before = shortcutLegend([S(['g'], 'G', { label: 'snap' })])
  const after = shortcutLegend([S(['g'], 'G', { label: 'snap' }), S(['m'], 'M', { label: 'mute' })])
  assert.equal(before.length, 1)
  assert.equal(after.length, 2)
  assert.equal(after.at(-1)!.label, 'mute')
})

test('every legend row has a label worth showing', () => {
  const list = [S(['g'], 'G', { label: 'snap' })]
  for (const row of shortcutLegend(list)) {
    assert.ok(row.hint.trim().length > 0, 'a blank hint renders as an empty key cap')
    assert.ok(row.label.trim().length > 0, 'a blank label renders as a dangling word')
  }
})

// --- what the user is typing ----------------------------------------------

const el = (tag: string, extra: Record<string, unknown> = {}): HTMLElement =>
  ({ tagName: tag, ...extra }) as HTMLElement

test('text entry is left alone', () => {
  for (const tag of ['INPUT', 'TEXTAREA']) {
    assert.equal(shouldIgnore(el(tag), 'g'), true, `${tag} must keep its keys`)
  }
  assert.equal(shouldIgnore(el('DIV', { isContentEditable: true }), 'g'), true)
})

test('a focused button keeps space and enter, but not other keys', () => {
  // Otherwise one keypress both activates the button and runs the command.
  const button = el('BUTTON')
  assert.equal(shouldIgnore(button, ' '), true)
  assert.equal(shouldIgnore(button, 'Enter'), true)
  assert.equal(shouldIgnore(button, 'g'), false, 'other shortcuts still work')
})

test('ordinary elements are not spared', () => {
  assert.equal(shouldIgnore(el('DIV'), 'g'), false)
  assert.equal(shouldIgnore(el('CANVAS'), ' '), false)
})
