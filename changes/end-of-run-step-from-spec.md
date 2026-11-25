---
packages: @parcha/agentrun-serve
kind: breaking
---
The adapter loop takes a run's end-of-run step from the run's spec only (`AdapterRunSpec.endOfRun`), never from the deps a runner hands the loop. A conformance subject (`@parcha/agentrun-serve/conformance`) now puts `setup.endOfRun` on its spec, as it puts `setup.agentId`; one that drops it fails the `end-of-run-answer` case.
