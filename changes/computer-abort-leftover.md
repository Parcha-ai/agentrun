---
packages: @parcha/agentrun-computer
kind: fix
---
A Docker `create` aborted during a `docker run` (the egress proxy's, or the computer's own) no longer leaves a container Created behind. The abort kills the docker CLI, but the Docker daemon can still finish making the container a moment later, after the single `docker rm` of create's cleanup found nothing; the janitor took it only at a later sweep. Now, after a `docker run` that did not end with an exit of its own, the provider removes the container by name, with its anonymous volumes (and the egress volume), then looks again, every 500 ms on a bound of its own of 10 s (never the caller's, already aborted), until the looks have found none of them for 3 s in a row. The error still says create was aborted, and what was removed or could not be, always by name. A create later than that is still the janitor's sweep's, as before. A `docker run` that ended with an exit of its own is cleaned up as before.
