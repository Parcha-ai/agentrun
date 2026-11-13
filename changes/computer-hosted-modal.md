---
packages: @parcha/agentrun-computer
kind: breaking
---
Modal computers run on the shared machine-host adapter: `src/modal.ts` is Modal's `MachineHost` (pid1, no file API, labels as tags) and the adapter does the rest. Breaking: `daemonImage` is gone (the daemon is always uploaded, and `COMPUTER_MODAL_DAEMON_IMAGE` is no longer read); `modalCommands`, `untilFinished` and `dist/conformance/modal-sweep.js` are gone (sweep a live run with `dist/conformance/sweep.js --provider modal`, whose before file records the app and server); `ModalProvider`'s `user` option is the adapter's `daemonUser` (uid:gid) and its `timeouts` are the adapter's (`requestMs`, `goneMs`, `pollMs` in place of `callMs`, `releaseMs`, `releasePollMs` and `endedMs`); a spec's `workdir` is refused (a Modal computer works in /work); a computer takes 5 labels of its caller's, not 6; attach reports no `cpus`, `memoryMb` or `gpu` (Modal reads none back), and a refused create no longer gives the sandbox's own exit words.
