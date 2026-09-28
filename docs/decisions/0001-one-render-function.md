# ADR-1: One render function

**Status:** Accepted. This is the most important decision in the project.

## Context

Editors end up with "the preview doesn't match the export." That bug is unfixable
at scale, because once there are two renderers, every visual change has to be
made twice and the two drift immediately.

## Decision

`render.ts` exports a single function:

```ts
renderFrame(ctx, image, clip, options): void
```

Preview calls it. Export calls it. There is no second implementation, so there is
nothing to drift. Text layout, transforms, rotation and caption rendering all
live inside it.

`render.ts` takes **no time parameter**. It draws one image; what to draw is the
caller's problem. This is not pedantry — if the renderer needed the playhead,
preview and export would start passing different things to it and the guarantee
would quietly become a convention rather than a structural fact.

## Alternatives considered

- **A second, faster export renderer.** Rejected: "faster" is exactly how the two
  diverge, and nobody can tell which one is right when they disagree.
- **A declarative effect list, interpreted by one renderer.** This is roughly what
  we have, expressed as code rather than data. Same guarantee, less machinery.

## Consequences

- WYSIWYG is structural, not aspirational.
- Preview and export *do* differ in one way: preview decodes approximately (from
  the nearest keyframe, possibly late), export decodes exactly. **The pixels
  drawn are identical**; only which source frame is fetched differs.
- `render.ts` must not grow a second code path. If it does, this ADR is dead.
