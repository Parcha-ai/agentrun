---
packages: @parcha/agentrun-serve
kind: feature
---
The server's image can include the Claude Agent SDK and its CLI: `docker build --build-arg CLAUDE_AGENT_SDK=0.3.286` (the version the lock pins) keeps them, so `claude-agent` runs in the container, and the build fails if the value is not the version the lock installs. Without the argument, the default, the image carries neither, as before. `render.yaml` asks for `CLAUDE_AGENT_SDK` too, since Render passes a Docker service's environment to the build as build arguments.
