---
packages: @parcha/pi-transport
kind: breaking
---
The session home, the box place, and the home's move, restore and store checks are removed, as 0.1.0-beta.30 announced. Nothing in agentrun-serve or the harness used them: they run agents in boxes through this package's boxes, `./hands` and `./sync`, which stay.
- Gone: the `@parcha/pi-transport/home` entry (the movers `sealStore`, `checkpointStore`, `verifyStore`, `moveWorkspace` and `moveFile`; `openHome`, `connectHome`, `runMain`, `moveHome` and `recoverHome`; checkpoints and their vault; the record stream; and the ownership lease `leaseIn` with `dirStore`).
- Gone: the `@parcha/pi-transport/place` entry (`boxPlace` and its types).
- Gone from `@parcha/pi-transport/testing`: `registerMoveConformance`, `registerRestoreConformance`, `moveConformanceApp`, `registerStoreConformance`, `createStoreConformance` and their types. The box checks and the fake providers stay.
- Upgrading: import `Manifest`, `ManifestEntry`, `Pipe` and `WorkspaceError` from `@parcha/pi-transport/sync`, and boxes from the root and `./box/<provider>`. To run an agent in a box, use `@parcha/agentrun-serve`. The launcher, the placer, `replayClassifier`, `FakeLaunch` and the `home`, `auto` and `purpose` config keys are still deprecated and go in a later release.
