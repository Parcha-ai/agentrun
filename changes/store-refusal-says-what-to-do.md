---
packages: @parcha/agentrun-serve
kind: fix
---
A server started on a store an earlier release set up is still refused, but the refusal now says what to do: start on a new, empty data folder (`--data <new folder>`, with the Docker image's flags; on Render the Docker Command must be the whole start command, as it replaces the entrypoint too), add agents, MCP servers, keys and sign-ins again, and keep the old folder to stay on the earlier release; a store a later release set up says to run that release or later.
