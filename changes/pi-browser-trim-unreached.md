---
packages: @parcha/pi-browser
kind: breaking
---
The package keeps only what a host runs: the core, `/durable`, `/live-view`, `/driver/stagehand`, `/testing` and the providers (Browserbase, Kernel and the local Chrome). Three entries are removed:
- `/coding-agent`, the pi coding agent's extension, and the package's `pi` manifest, so `pi install npm:@parcha/pi-browser` no longer loads browser tools. A host installs the durable adapter (`/durable`, `createBrowserExtension`) on a pi-durable Harness instead. `findChrome` moves to `/providers/chrome-args`, and `@earendil-works/pi-coding-agent` is no longer a peer.
- `/recorder` (`frameRecorder`, `exportFrameTracks`).
- `/providers/assigned` (`assignedSessionProvider`). A host that hands the run one session of its own implements `BrowserProvider` with `caps.fixedSession: true`, which the durable adapter still honours.
