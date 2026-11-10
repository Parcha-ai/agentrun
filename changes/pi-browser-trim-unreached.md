---
packages: @parcha/pi-browser
kind: breaking
---
The package keeps only what a host runs: the core, `/durable`, `/live-view`, `/driver/stagehand`, `/testing` and the providers (Browserbase, Kernel and the local Chrome). Three entries are removed, with no replacement shim:
- `/coding-agent`, the pi coding agent's extension: `createBrowserExtension`, the default export, `LocalCustody`, `SESSION_ENTRY`, `CodingAgentOptions` and its re-export of `findChrome`. The package's `pi` manifest goes with it, so `pi install npm:@parcha/pi-browser` no longer loads browser tools, and `@earendil-works/pi-coding-agent` is no longer a peer. Use instead: the durable adapter, `createBrowserExtension` from `@parcha/pi-browser/durable`, installed on a pi-durable Harness; `findChrome` from `@parcha/pi-browser/providers/chrome-args`.
- `/recorder`: `frameRecorder`, `exportFrameTracks`, `planTrack`, `TrackExportError`, `CREDENTIAL_PROBE`, `jpegSize` and their types (`FrameData`, `FrameGapData`, `FrameLine`, `FrameRecorder`, `FrameRecorderOptions`, `FrameSink`, `FrameTrackData`, `FrameTrackLine`, `Track`, `TrackFrame`, `TrackGap`, `TrackIndex`, `TrackOptions`, `TrackPlan`, `TrackSegment`). Nothing replaces them: a host that records a session's frames does it over the session's DevTools connection itself.
- `/providers/assigned`: `assignedSessionProvider` and `AssignedSession`. Use instead: a `BrowserProvider` of the host's own whose `caps.fixedSession` is `true`; the durable adapter refuses `browser_relaunch` on it as before.
