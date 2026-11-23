---
packages: @parcha/agentrun-serve
kind: fix
---
The Docker reason a server gives in a container now depends on which container it is. AgentRun's image says so itself (`AGENTRUN_IN_IMAGE=1`), so a Kubernetes pod, which has no `/.dockerenv`, gets the socket advice too. That advice now says the host's Docker socket is root on the host. Any other container, such as a dev container running `npx @parcha/agentrun`, gets the host's words, prefixed "This server runs in a container.", and no compose.yaml advice.
