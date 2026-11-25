---
packages: @parcha/agentrun-serve
kind: ci
---
serve's stalled-read, lookup-timeout and cut-turn cases no longer wait out real timers: the end's metrics bound is armed on an injected timer (`endPatchTimer`, one option for the native, SDK and adapter loops in place of two `endPatchMs`), so each stall runs out the moment the case moves a fake clock, and the cases wait on the runner's end event, the turn's own abort and `follow`'s new `done` predicate instead of sleeps and wall-clock loops.
