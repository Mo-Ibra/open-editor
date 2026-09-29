# Traces

One user action, followed all the way down through every layer, with the
reasoning at each step.

Reading source top to bottom is the slow way to learn a codebase, because it
shows you the code without the thread that runs through it. A trace gives you
the thread, and each stop explains itself. Three are written up; each one is a
complete tour of a different part of the system.

| Trace | Action | Teaches |
|---|---|---|
| [01-split.md](01-split.md) | Press `S` | The model, the store, selection policy, history, and why the timeline re-renders by itself. |
| [02-playback.md](02-playback.md) | Press play | Why preview is approximate and export is exact — the A/V contract. |
| [03-audio.md](03-audio.md) | Read the audio | Why there are three audio files, and what they promise each other. |

Start with 01. It is the shortest, and it touches every layer.

## These are checked

Every `file:line` reference in these documents is verified by a test, so a
renamed function or a moved file fails the build rather than quietly sending you
to the wrong line. See the guard at the end of `test/dom.test.ts`.

That means line numbers here are load-bearing, and they are kept correct rather
than being allowed to rot. If you add a citation, use the full path from the
repository root — `src/model/project.ts:446` — or the guard cannot see it.
