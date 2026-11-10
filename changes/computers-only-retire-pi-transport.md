---
packages: @parcha/agentrun-serve
kind: breaking
---
Runs execute on computers only, and the old box stack is gone from the server. `@parcha/pi-transport` is no longer in this repository or in a release, and the server no longer depends on it. A server's start no longer builds pi-transport box providers, opens a Daytona or Modal relay, or starts a box egress container. The places an agent can name are unchanged (`runner`, or `sandbox` on `docker`, `daytona`, `modal` or `bwrap`), and so is `capabilities.places`. A sandbox place on a box runs on that provider's sandbox computer, as it already did.
- Docker is still probed at the start (`docker version`), with the same words when it isn't there. Daytona and Modal are offered when their computer provider's required keys are set, in the server's environment or saved in Settings → Computers. Nothing is asked of either vendor at the start: a key the vendor refuses fails the run's computer start, in the vendor's words.
- `AGENTRUN_BOX_CPUS`, `AGENTRUN_BOX_MEMORY` and `AGENTRUN_BOX_PIDS` are no longer read, and no longer refuse a start. They sized the old Docker and Modal boxes, which runs no longer use.
- A Daytona or Modal box shows `network: none`, with a `network_reason`, whatever `AGENTRUN_BOX_ALLOW` names. Their computers are never made with a host list, so capabilities now say what a run gets. Before, a Daytona box was shown with the allowlist.
