# ADR-8: Never hardcode an output codec

**Status:** Accepted — and it bit us in Phase 0.

## Context

It is tempting to write `codec: 'avc', audio: 'aac'` and ship it.

## Decision

Negotiate at export time. Probe, and keep every combination that survives:

1. The **container** can hold it — `format.getSupportedVideoCodecs()` /
   `getSupportedAudioCodecs()`
2. The **browser** can encode it — `VideoEncoder.isConfigSupported` /
   `AudioEncoder.isConfigSupported`
3. The user **actually has audio** to encode

Show the user the list, let them choose, and show the reasons the others were
rejected.

## Why

**AAC encoding does not exist on Linux.** Chrome and Edge only encode AAC on
macOS, iOS and Windows, via the platform encoder. On Linux this returns
`supported: false` and the encoder throws:

```
This specific encoder configuration (mp4a.40.2, 128000 bps, 2 channels, 48000 Hz)
is not supported in this environment.
```

Every parameter is valid. The encoder simply does not exist. Firefox has the same
gap. A tool that hardcodes AAC works on the developer's Mac and fails for everyone
on Linux — which is most of the people who would install it.

**The container switch is not optional either.** Opus-in-MP4 muxes without
complaint and produces a file that **will not play**. A valid container holding a
codec nobody's player opens is the worst possible failure, because it looks like
success until someone tries to watch it. If AAC is unavailable, switch the
*container*, not just the codec.

## Alternatives considered

- **Bundle a software AAC encoder.** Rejected for now: several MB of WASM for a
  codec the platform usually provides.
- **Fall back silently.** Rejected. A user who gets `.webm` instead of the `.mp4`
  they expected deserves to know why.

## Consequences

- The output format **cannot be fixed at build time**. "MP4" is a preference, not
  a guarantee.
- The export dialog probes what is actually available and offers a real choice,
  including MP4 + MP3 for platforms that will not take WebM.
- Every rejection is recorded and shown, so the format is never a mystery.
