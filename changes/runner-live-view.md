---
packages: @parcha/agentrun-serve
kind: fix
---
A run on the runner shows what it is doing while it does it: every runner (the runner process, the runner beside the server and the conformance harness) now writes its runs' live view, where no production runner did before.
- Each run's held state (the tools running now, with the output they have streamed so far, and a partial answer) is written to the run's live view once a tick (250 ms), batched for all the runner's runs in one store write, and goes when the run's loop ends.
- A runner that closes keeps its runs' live view through the drain, until each loop ends; one whose claim on a run is lost (fenced, or not renewed before its lease ends) writes no more of that run's view, and one killed (a crash) writes nothing more at all.
- A test that wraps a runner's loops in a live ticker of its own, or wants none, passes `live: false` to startRunner.
