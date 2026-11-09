---
packages: @parcha/agentrun-serve
kind: feature
---
AgentRun's container image runs the server and its runners: the default command is the server with one runner beside it; with runners of their own, the server takes `--no-runner` and each runner is the same image with `runner --data /data --name <name> [--loops N]`, against the same `/data` volume, so a runner always knows the schema of the store its server set up. `deploy/compose.yaml` runs a server and two runners on one store, and `deploy/README.md` says how to run more.
- The image is on Node 24 (`node:24.21.0-trixie-slim`, pinned by digest), the Node the workspace needs, and carries the computer daemon's Linux binaries (`computerd-linux-amd64` and `-arm64` in `@parcha/agentrun-computer`'s dist), built with Go 1.24.13 in the build stage only.
- The seal key comes from the operator: the server and every runner must be given the same `AGENTRUN_SEAL_KEY` (`openssl rand -base64 32`). A container given none makes its own, which no other container shares.
- A runner starts after the server is healthy (only the server sets the store up; a runner on a store it does not know exits 3), and its health is `runner --check --data /data --name <name>`. On SIGTERM it hands its runs back at once and gives up a stuck loop at 25 s: give it 35 s to stop.
- `deploy/walk/smoke.sh` (CI's `deploy-compose` job) and `deploy/walk/reclaim.sh` walk the stack on the faux model: a run completes on a runner, and a run whose runner gets SIGTERM or SIGKILL mid-run is taken over by the other runner and completes with each step done once.
- No upgrade in place: a `/data` volume from an earlier server holds its old store in `store.sqlite`, which the new server refuses at start. Keep the earlier version on that volume, or start on a new data directory and re-create the agents.
