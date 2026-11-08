---
packages: @parcha/pi-durable-disk
kind: ci
---
A run's two remaining barriers, `runStatus` and `runRelease`, name their proof: a box-loss test that ends a run through `Run.setStatus` (a `done` status, and a `sleeping` one with its wake time) or through `release()` with its WAL kept, loses the box the moment the end resolved, and shows the next incarnation reads that record and every commit before it. Every active barrier now names its proof, so that condition for a NORMAL run journal is done.
