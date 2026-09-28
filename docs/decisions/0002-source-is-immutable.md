# ADR-2: The source file is never modified

**Status:** Accepted.

## Context

The obvious way to "cut" a video is to write a new file. That is destructive, slow
(it re-encodes on every edit), and puts the user's only copy at risk.

## Decision

Cutting never writes to the media. There is no "save the project over your file",
no destructive trim, no in-place edit. A project is a JSON file of pointers into
files that stay exactly where they are.

## Alternatives considered

- **Copy fragments to a cache on trim.** Rejected: disk churn, and it breaks the
  promise that a dropped file is instantly playable.
- **Non-destructive editing but "flatten to a new file" on export.** That is what
  we do — export is the *only* place bytes are written.

## Consequences

- Undo is free. It is a snapshot of two arrays, not a history of inverse
  operations.
- A project is a few KB of JSON.
- **A bug can never destroy someone's footage.** This is the single most
  important safety property in the product, and it costs nothing.
