/**
 * The context menu, built from what was right-clicked.
 *
 * Split out of `app.tsx` because it was a quarter of that file and had nothing
 * to do with the shell. It is a pure function of (state, target, layout), which
 * makes the menu's shape testable without rendering anything.
 *
 * One rule runs through all of it: **every row does something real.** A menu of
 * disabled placeholders is worse than no context menu, because it teaches
 * people that the feature does not exist. Where an action does not apply to the
 * current target it is either omitted, or shown disabled *with a reason the
 * user can read* — never present-but-dead.
 */

import { dump } from '../../dev/debug.js'
import { trackTypeById } from '../../model/project.js'
import type { AppState } from '../store/state.js'
import type { LayoutState } from '../store/layout.js'
import type { ContextMenuState, MenuItem } from '../view/ui/ContextMenu.js'
import type { Fullscreen } from '../view/shell/fullscreen.js'

export function menuItems(
  state: AppState,
  menu: ContextMenuState,
  layout: LayoutState,
  fullscreen: Fullscreen,
): MenuItem[] {
  const target = menu.open()

  if (target?.kind === 'clip') {
    // The timeline's right-click has already made the selection match the
    // target, so these act on the whole selection — one clip, or a ctrl-clicked
    // group. Labels name the count rather than saying "clip" and leaving the
    // user to work out how many are lit up.
    const n = state.selectionCount()
    const many = n > 1
    const clips = state.selectedClips()
    const linked = state.selectionHasLinks()
    const audio = clips.filter((c) => trackTypeById(state.project, c.trackId) === 'audio')
    const video = clips.filter((c) => trackTypeById(state.project, c.trackId) === 'video')
    const allMuted = audio.length > 0 && audio.every((c) => c.muted)
    const allHidden = video.length > 0 && video.every((c) => c.hidden)
    const count = (one: string, plural: string): string => (many ? plural.replace('%d', String(n)) : one)

    return [
      {
        label: count('Split at playhead', 'Split %d clips at playhead'),
        shortcut: 'S',
        disabled: n === 0,
        run: () => state.splitSelectionAtPlayhead(),
      },
      {
        label: count('Duplicate', 'Duplicate %d clips'),
        shortcut: '⌘D',
        disabled: n === 0,
        run: () => state.duplicateSelected(),
      },
      { separator: true, label: '', run: noop },
      {
        label: count('Trim to playhead', 'Trim %d clips to playhead'),
        disabled: n === 0,
        run: () => state.trimSelectionToPlayhead(),
      },
      // A status, not an action. Offering a disabled "Break link" on an
      // unlinked clip would look clickable and do nothing; saying "unlinked"
      // as plain text is the honest answer and costs no interaction.
      ...(linked
        ? [
            {
              label: count('Break link', 'Break %d links'),
              disabled: false,
              run: () => state.breakSelectedLinks(),
            },
          ]
        : [{ label: 'unlinked', status: true, run: noop }]),
      // One row per lane, and each says exactly what it does to that lane.
      // A single combined "Mute sound and picture" row used to appear whenever
      // a linked pair was selected, so right-clicking the *video* offered
      // "Mute" — which reads as an audio action on a picture clip. The video
      // and audio rows are independent, so a mixed selection gets both and the
      // user is never guessing which lane an action hits.
      ...(video.length > 0
        ? [
            {
              label: count(
                allHidden ? 'Show picture' : 'Hide picture',
                allHidden ? 'Show %d pictures' : 'Hide %d pictures',
              ),
              shortcut: 'M',
              disabled: false,
              run: () => state.toggleHiddenSelected(),
            },
          ]
        : []),
      ...(audio.length > 0
        ? [
            {
              label: count(allMuted ? 'Unmute sound' : 'Mute sound', allMuted ? 'Unmute %d clips' : 'Mute %d clips'),
              shortcut: 'M',
              disabled: false,
              run: () => state.toggleMuteSelected(),
            },
          ]
        : []),
      { separator: true, label: '', run: noop },
      {
        label: count('Delete clip', 'Delete %d clips'),
        shortcut: '⌫',
        danger: true,
        disabled: n === 0,
        run: () => state.deleteSelected(),
      },
    ]
  }

  if (target?.kind === 'track') {
    const trackId = target.trackId ?? state.project.tracks[0]?.id
    if (!trackId) return []
    const isAudio = trackTypeById(state.project, trackId) === 'audio'
    const selectedFile = state.selectedAsset()
    const file = selectedFile ? state.project.assets[selectedFile] : undefined
    return [
      {
        label: file ? `Add "${file.name}" here` : 'Add the selected file here',
        disabled: !file,
        run: () => {
          if (selectedFile) state.addAssetAt(selectedFile, trackId, state.playhead())
        },
      },
      { separator: true, label: '', run: noop },
      {
        label: `Clear ${isAudio ? 'audio' : 'video'} track`,
        danger: true,
        disabled: state.trackById(state.project, trackId).length === 0,
        run: () => state.clearTrack(trackId),
      },
    ]
  }

  if (target?.kind === 'asset') {
    const assetId = target.assetId
    return [
      { label: 'Add to timeline', run: () => assetId && state.addAssetToTimeline(assetId) },
      { label: 'Select', run: () => assetId && state.setSelectedAsset(assetId) },
      { separator: true, label: '', run: noop },
      {
        label: 'Remove from project',
        danger: true,
        run: () => assetId && state.removeAsset(assetId),
      },
    ]
  }

  if (target?.kind === 'preview') {
    const hidden = layout.pictureHidden()
    return [
      // The picture is the point of the app, so it gets the first two rows: the
      // only two actions that change what you are looking at rather than what
      // you are editing.
      {
        label: hidden ? 'Show the picture' : 'Hide the picture',
        shortcut: 'H',
        run: () => layout.togglePicture(),
      },
      {
        label: 'Full screen',
        shortcut: 'F',
        // With the picture hidden there is nothing to go full screen *on*, so the
        // row is disabled and the label says why. Hidden instead would read as
        // "this does not exist", which is the wrong answer — the user just asked
        // for it.
        disabled: hidden,
        run: fullscreen.toggle,
      },
      { separator: true, label: '', run: noop },
      { label: 'Fit to window', run: () => state.resetView() },
      { label: 'Reset zoom', run: () => state.setTransformActive({ scale: 1, x: 0, y: 0 }) },
      { separator: true, label: '', run: noop },
      { label: 'Copy logs', run: () => void navigator.clipboard?.writeText(dump()) },
    ]
  }

    // The app itself: anything not on a clip, a track, an asset, or the picture.
  return [
    { label: 'Undo', shortcut: '⌘Z', disabled: !state.canUndo(), run: state.undo },
    { label: 'Redo', shortcut: '⇧⌘Z', disabled: !state.canRedo(), run: state.redo },
    { separator: true, label: '', run: noop },
    {
      label: state.clipSnap() ? 'Clip snap: on' : 'Clip snap: off',
      shortcut: 'G',
      run: () => state.setClipSnap(!state.clipSnap()),
    },
    {
      label: state.laneSnap() ? 'Lane snap: on' : 'Lane snap: off',
      shortcut: '⇧G',
      run: () => state.setLaneSnap(!state.laneSnap()),
    },
    {
      label: state.playheadSnap() ? 'Playhead snap: on' : 'Playhead snap: off',
      shortcut: 'P',
      run: () => state.setPlayheadSnap(!state.playheadSnap()),
    },
    // Only when there is sound to mute. A "Mute" row on a project with no audio
    // is a promise the app cannot keep, and it appears — and reads as broken —
    // on the empty timeline most users right-click first.
    ...(state.project.tracks.some((t) => t.type === 'audio' && t.clips.length > 0)
      ? [
          { separator: true, label: '', run: noop },
          {
            label: state.audio.isMuted ? 'Unmute' : 'Mute',
            shortcut: 'M',
            run: () => state.audio.setMuted(!state.audio.isMuted),
          },
        ]
      : []),
    { separator: true, label: '', run: noop },
    { label: 'Reset panels', run: () => layout.reset() },
    { label: 'Copy logs', run: () => void navigator.clipboard?.writeText(dump()) },
  ]
}

function noop(): void {}
