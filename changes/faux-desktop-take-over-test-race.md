---
packages: @parcha/agentrun-serve
kind: ci
---
The faux desktop's Take over test takes over only after the agent's first look is done. It used to wait for the run read's computer `ready`, which says only that the run is past queued: on a loaded runner the take-over could land before the first look, that look parked under the person's hold as designed, the second look was never asked for, and the test waited out its 120 s timeout. Each of its waits is now bounded and fails in words.
