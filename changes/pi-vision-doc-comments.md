---
packages: @parcha/pi-vision
kind: docs
---
Every name the package exports has a doc comment: `createVisionExtension`, `piAiEyes`, `VisionOptions`, `VisionHandle`, `Provider`, `EyesAnswer`, `LookRecord`, `EvidenceSink`, `VisionEnv`, `MissCode`, the providers, the transcribers' option types, the test kit and the rest, 86 in all. An editor shows them on hover and the published declarations carry them. `test/api-docs.test.mjs` fails when an export of any entry has none, naming it.
