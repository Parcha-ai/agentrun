---
packages: @parcha/agentrun-serve
kind: breaking
---
Runs execute on computers only: the old box stack is gone from the server, and `@parcha/pi-transport` with it.
- `@parcha/pi-transport` is no longer built or published, and the server no longer depends on it. A program that imports it keeps the last published version (0.1.0-beta.33) or moves to `@parcha/agentrun-computer`.
- A Daytona or Modal box in `capabilities.places.boxes` now reports `network: none`, with a `network_reason`, whatever `AGENTRUN_BOX_ALLOW` names, because their computers are never made with a host list. An agent on Daytona or Modal that needs a host uses `web_fetch`, or a Docker place.
- The server no longer builds or pulls an `agentrun-box` image at its start (a fresh server spent up to 10 minutes on an image no run used). A Docker computer builds its own image on its first run, and that run's timeline shows it. An `agentrun-box:*` image left on a Docker host can be removed with `docker image rm`.
- A box's `state` is never `preparing` now, and the start no longer prints the box image lines. A client that waited on `preparing` waits on nothing: a box is `ready` or `unavailable`.
- `AGENTRUN_BOX_CPUS`, `AGENTRUN_BOX_MEMORY` and `AGENTRUN_BOX_PIDS` are no longer read and no longer refuse a start. Remove them from the server's environment.
- Daytona and Modal are offered when their computer provider's required keys are set (the server's environment, or Settings → Computers), and nothing is asked of either vendor at the start. A key the vendor refuses now fails the run's computer start, in the vendor's words. Docker is still probed with `docker version`.
