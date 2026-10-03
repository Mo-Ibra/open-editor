# Documentation

## How to read this

Three kinds of document, and the difference matters:

- **Description** — how the code works *now*. `architecture`, `data-model`,
  `media`, `export`, `development`. If one of these is wrong, the code is wrong.
- **Decision** — why it is like that, including what was tried and rejected.
  `decisions/`. These have stable numeric IDs and never get renumbered, so
  `ADR-4` means the same thing forever.
- **Intent** — what is planned, what is known-fragile, what is undecided.
  `roadmap`, `risks`.
- **Onboarding** — how to learn the thing. `reading-order`, `traces/`. Starts
  where the others assume you already know something.

**Start here if you are new:** [reading-order.md](reading-order.md), then any
one of the [traces](traces/). The rest of this set assumes you have the map.

The old `PLAN.md` mixed all three in one 754-line file, and drifted: its module
map described files that were never written, and its type definitions showed
`version: 1` after the model had moved to version 2. Splitting them is what keeps
description honest.

## Contents

| File | What it answers |
|---|---|
| [architecture.md](architecture.md) | What are the modules, and who calls whom? |
| [data-model.md](data-model.md) | How is a project represented? Why is position derived? |
| [media.md](media.md) | How does a dropped file become decodable frames? |
| [export.md](export.md) | How does a timeline become a playable file? |
| [development.md](development.md) | How do I run, test, and add a test? |
| [traces/](traces/) | What actually happens when I press a key? |
| [reading-order.md](reading-order.md) | I'm new. What do I read, in what order, and what can I skip? |
| [reading-order.md](reading-order.md) | I want to understand this codebase. What do I read, in what order, and what can I skip? |
| [traces/](traces/) | What actually happens when I press a key? |
| [decisions/](decisions/) | Why is it built this way? |
| [risks.md](risks.md) | What is known to be weak? |
| [roadmap.md](roadmap.md) | What comes next? |

## The three ideas that explain most of the code

If you read nothing else, read these.

**1. The project is data, not code.** An array of clips and a handful of derived
functions. No undo engine, no command objects, no ECS. Undo is a snapshot of two
arrays. See [data-model.md](data-model.md).

**2. Position is derived, never stored.** A clip has no `start` field. Its
timeline position is the sum of what precedes it. A stored position and an array
index can disagree; a derived one cannot, which deletes an entire bug class. See
[data-model.md](data-model.md#position-is-derived).

**3. One render function.** Preview and export call the same code to draw the
same frame. Two renderers is how editors end up with "the preview doesn't match
the export", and that bug is unfixable at scale. See
[ADR-1](decisions/0001-one-render-function.md).

## Conventions in this codebase

- **Comments explain *why*, not *what*.** A comment restating the code is noise.
  A comment recording a measured result, a rejected alternative, or a trap
  someone already fell into is the most valuable thing in the file.
- **Pure logic is separated from I/O.** `model/project.ts` and `model/snapping.ts` have no
  Web APIs and no imports from the rest of the app, which is what makes them
  testable in Node with no browser.
- **Behaviour that cannot be seen is tested at the source level.** Some failures
  are invisible to a type checker *and* to any unit test — a component rendered
  twice, a CSS class that compiles to nothing, a snapping helper that is exported
  but never called. Those get structural assertions in `test/dom.test.ts` and
  `test/snapping.test.ts`, which read the source or the built CSS rather than
  running code.
