# ADR-9: Hiding the picture keeps the transport

**Status:** Accepted

## Context

The editor had two collapsible panels — the media sidebar and the timeline —
and both were only collapsible by **double-clicking a 1px resizer hairline**. The
state existed, the clamping worked, the sizes persisted. The feature was
complete and invisible.

Three things were asked for at once: a way to collapse the timeline, a way to
collapse the media panel, and a way to "unshow the video at all".

The third is the interesting one, because "hide the video" has two readings that
lead to different products.

## Decision

1. **Every collapsible panel gets a visible button.** The drag handle stays for
   resizing; the button says so out loud. A gesture discoverable only by
   hovering a hairline is a support question waiting to happen.
2. **Hiding the picture collapses the *canvas*, not the preview.** The transport
   bar stays, at 48px, and the timeline takes the rest of the column.
3. **Full screen is disabled while the picture is hidden**, with a label that
   says why, rather than being hidden from the menu.
4. Full screen uses the **Fullscreen API** on the preview stage, with `active`
   tracked from the `fullscreenchange` event rather than from the click.

## Why

**Collapsing the whole preview would take the play button with it.** A user who
asks for more timeline still needs to hear what they are cutting. Leaving a
48px transport strip is a small cost for keeping the app usable, and it means
"Hide the picture" answers "I want more timeline" rather than "I want to stop
working".

**The button is the feature; the hairline is the shortcut.** Double-click stays,
because someone who found it likes it, but it is no longer the only way.

**`active` is tracked from the event.** The user can leave full screen without
going through our button — Escape, another tab taking it. A toggle that drifts
out of step has exactly one visible symptom: a button that lies.

**A disabled row beats a missing row.** "Full screen" disappearing from the menu
reads as *this does not exist*. Showing it greyed out reads as *not right now*,
which is true and actionable.

## Alternatives considered

- **In-app "maximise" instead of the Fullscreen API.** Rejected: the browser
  chrome stays, so the picture is never actually as large as it can be. Escape
  does not leave, and there is no way to hand the screen to a video.
- **Fullyscreen with no user gesture.** Rejected: it is a security-relevant API
  and browsers reject it, so the state could never be reached deliberately.
- **Dragging the boundary to reopen the picture** (mirroring the sidebar, where
  dragging a collapsed panel re-opens it). Rejected: with the picture hidden the
  timeline owns the whole column, so there is no boundary to drag. A handle that
  moves is a handle whose meaning changes.
- **Hiding the picture while the timeline is collapsed.** Rejected: that leaves
  a 48px strip and no timeline, so there is nothing to edit. Hiding the picture
  now expands the timeline on the way through.

## Consequences

- `PREVIEW_TRANSPORT_ONLY` (48) duplicates the transport's height, so the markup
  uses an explicit `h-[48px]` rather than Tailwind's `h-12` — otherwise the two
  agree only as long as the root font size is 16px. `test/dom.test.ts` ties them
  together.
- The grid template is a pure function, `mainRows()`, so both arrangements are
  unit-testable without a DOM.
- Full screen is a seam (`app/view/fullscreen.ts`) rather than a `Preview`
  detail, because the button, the context menu and the `F` shortcut all need it
  and none of them can reach a component's ref.
- Four new keys: `H` (hide picture), `F` (full screen), `\` (timeline),
  `⌘\` (media).

## Three bugs this decision shipped with

All three were invisible to the type checker, the unit tests, and the build, and
all three were found by driving the real thing in a browser. They are recorded
here because each is a trap the next change will walk into again.

1. **The preview kept a dead 2D context.** `context()` cached the
   `CanvasRenderingContext2D` in a bare variable. Hiding the picture unmounts the
   canvas, so the `ref` rebinds to a *new* element while the cache still pointed
   at the destroyed one — and every render after that drew into a canvas that
   was no longer in the document. The picture went black and the health check
   printed `canvas on-screen 0x0 display= visibility= opacity=` (the empty values
   are the tell: `getComputedStyle` on a *detached* element returns empty
   strings) every five seconds, for the rest of the session.
   **The cache is now keyed on the element it came from.**
2. **A collapsed panel could not be brought back.** The toggle lived in the
   panel's own header, and a collapsed panel is 0px with `overflow-hidden`, so
   the button was clipped out of existence. The only ways back were the 1px
   hairline and a keyboard shortcut. A collapsed panel now grows a visible tab
   *outside* the clipped box, and the handle is a sibling of the panel rather
   than a child — for the timeline that meant moving it out of the 0-height
   wrapper, where it was present, correctly sized, and unclickable.
3. **A conditional `onClick` did not fire.** The tab was written as
   `onClick={collapsed() ? onToggle : undefined}`. Under Solid's event
   delegation the handler is a value read at dispatch time, and this form never
   arrived: a raw click reached the element and nothing happened. Always attach
   the handler and branch *inside* it.

A fourth, found while fixing the third: the tab was both a drag target and a
click target, and they fought — pointerdown expanded the panel and the click
collapsed it again, so the button did nothing. Drag-to-reopen was dropped.

## Hiding a *clip*, not the picture

Added later, and a different feature that arrived with the same name. `M` on a
**video** clip sets `hidden`; `M` on an **audio** clip sets `muted`. One key,
two meanings, because that is how it reads — a selected video clip has nothing
to mute, and a selected audio clip has nothing to hide.

- The picture is black in the preview **and** in the export
  (`clipRendersBlack`), because a file that did not match the preview is worse
  than a slow one. Hidden clips are not decoded at all.
- Both flags get a badge on the clip itself, visible **without** selecting it,
  and the clip is desaturated. Pressing `M` and then hunting for evidence is how
  a user concludes the key did nothing.
- The two flags are separate fields, and each model function refuses the wrong
  lane — the same rule `toggleMute` already used, for the same reason.

### A race, found because the probe was intermittent

Hiding a clip went black, then did not, then did again. A decode already in
flight resolved *after* the black was painted and put the frame back. The
existing staleness guard could not see it, because hiding does not move the
playhead — `requestedAt` was unchanged and the frame sailed through.

It passed one run and failed the next, which is the signature of a race, and the
only reason it surfaced at all was that the probe ran repeatedly. Fixed by
asking the question again where the answer matters: the decode re-resolves its
clip and paints black if it is now hidden.

## Not in this ADR: dropping anywhere

A separate change with its own semantics, recorded in
[docs/data-model.md](../data-model.md) and guarded in `test/dom.test.ts`. The
short version: overwrite is the default and Shift means insert, because a drop
onto occupied space that silently shuffles the whole edit is the more surprising
of the two.

## What this cost in verification

The probe that shipped the first version of this feature asserted
`document.querySelector('canvas')` exists after un-hiding the picture. That is
true whether or not anything is drawn into it, so it passed while the picture
was black. **Asserting that a node exists is not a claim that it works.** The
replacement probes measure the app's own log output, `getComputedStyle`, and
`elementFromPoint` — what a user would actually see and hit.
