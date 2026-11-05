---
packages: @parcha/pi-transport
kind: feature
---
**Deprecated: the session home, the launcher and the placer. They are removed in 0.1.0-beta.31.** Nothing is removed in this release, and nothing behaves differently. To run an agent in a box, use `@parcha/agentrun-serve`: it uses this package's boxes, `./hands` and `./sync`, which stay.
- Every export of `@parcha/pi-transport/home`, `@parcha/pi-transport/launch` and `@parcha/pi-transport/place` is marked `@deprecated`, so an editor and a linter flag it where it is imported.
- From the root: `BoxLauncher`, `Box.launcher`, and the placer's `jevPlacer`, `jevClassifier`, `environmentFacts`, `PlacementsDoc`, `writePlacement`, `isPlacementRecord`, `PlacementError` and the `Placement*` and `Placer` types.
- From `@parcha/pi-transport/testing`: `registerMoveConformance`, `registerRestoreConformance`, `moveConformanceApp`, `registerStoreConformance`, `createStoreConformance`, `replayClassifier`, the other exports of those modules, and `FakeLaunch`.
- The config keys `home`, `auto` and `environments.<id>.purpose`. From 0.1.0-beta.31 a config that sets one of them fails to parse.
- `Manifest`, `ManifestEntry`, `Pipe`, `WorkspaceError` and `WorkspaceErrorCode` stay: import them from `@parcha/pi-transport/sync`, which exports the same types.
