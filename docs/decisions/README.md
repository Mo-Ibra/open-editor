# Architecture decision records

One file per decision. The numeric IDs are **stable and never reused** — `ADR-4`
means the same thing forever, which is why code comments can point at one.

| ID | Decision | Status |
|---|---|---|
| [0001](0001-one-render-function.md) | One render function for preview and export | Accepted — the most important decision here |
| [0002](0002-source-is-immutable.md) | The source file is never modified | Accepted |
| [0003](0003-re-encode-only.md) | Re-encode on export; no stream-copy fast path | Settled by measurement |
| [0004](0004-deterministic-audio-mixing.md) | Deterministic `Float32Array` mixing, not Web Audio graphs | Accepted |
| [0005](0005-backpressure.md) | Never busy-wait an encoder queue | Accepted |
| [0006](0006-trim-only-snapping.md) | Snapping applies to trims only | Superseded by [0011](0011-snapping-moves-too.md) |
| [0007](0007-no-ffmpeg.md) | No ffmpeg.wasm | Accepted |
| [0008](0008-negotiate-never-hardcode-a-codec.md) | Never hardcode an output codec | Accepted — and it bit us |
| [0009](0009-hide-the-picture-keeps-the-transport.md) | Hiding the picture keeps the transport | Accepted |
| [0010](0010-copy-media-and-reopen-what-you-can.md) | Copy the media into storage, and reopen what you can | Accepted |
| [0011](0011-snapping-moves-too.md) | Snapping applies to moves as well as trims | Accepted — supersedes [0006](0006-trim-only-snapping.md) |

## Writing a new one

Copy the shape of an existing file: Context, Decision, Alternatives considered,
Consequences, and a Status line. If a decision is reversed, do not delete the
file — write a new one that supersedes it and mark the old as superseded. The
rejected alternatives are usually the most valuable part.
