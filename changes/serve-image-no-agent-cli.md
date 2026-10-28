---
packages: @parcha/agentrun-serve
kind: fix
---
AgentRun Server's image carries no coding-agent CLI whose licence has not been reviewed for it. The Claude Agent SDK (with its platform packages, which hold the Claude CLI) and the Codex CLI are dev dependencies of the adapters, so the image's `npm ci` installed them. The Dockerfile now removes them after the build, and `docker/image-check.sh` fails the build if any copy is left in the final tree, nested ones included. Until a CLI is cleared and installed in the image on purpose, the image reports that harness as not set up.
- `docker/image-smoke.sh <image> [docker run arguments...]` checks that a built image serves: in a container published on a loopback port only, `GET /v2/health` answers 200 ok and `GET /v2/capabilities` answers with the contract; where capabilities list harnesses, pi is available and every other harness is unavailable with a reason a person can act on (a reason that says it is not installed gives the line that installs it), not an import error. On a failure it shows the container's log with keys withheld; it always removes the container.
