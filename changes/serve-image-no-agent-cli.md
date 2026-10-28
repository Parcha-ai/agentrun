---
packages: @parcha/agentrun-serve
kind: fix
---
AgentRun Server's image carries no coding-agent CLI whose licence has not been reviewed for it. The Claude Agent SDK (with its platform packages, which hold the Claude CLI) and the Codex CLI are dev dependencies of the adapters, so the image's `npm ci` installed them. The Dockerfile now removes them after the build, and `docker/image-check.sh` fails the build if any copy is left in the final tree, nested ones included. Until a CLI is cleared and installed in the image on purpose, the image reports that harness as not set up.
