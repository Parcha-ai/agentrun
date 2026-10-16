---
packages: @parcha/pi-transport
kind: feature
---
The placer: `jevPlacer` asks Jev through pi-ai's `Models.classify` where a session's next step should run (one call,
`need` against the resting place and `where` among the environments) and moves it only for a need; every decision is
a `PlacementRecord` by `jev` or `config`, kept in the session's store (`transport.placements`) with
`HomeHandle.recordPlacement`. It refuses to build without the classifier model or its key. The config gains
`environments.<id>.purpose`, `auto.rest` and `auto.threshold`. `./testing`: `replayClassifier` and
`recordingClassifications`.
