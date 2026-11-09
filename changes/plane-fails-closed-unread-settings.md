---
packages: @parcha/agentrun-serve
kind: fix
---
With the server's tool settings unreadable, approvals never no longer turns a harness's own (native) search on: the plane fails closed like the gate. While tool-settings.json is present but does not read (not JSON, or not an object of tools), every tool takes its defaults, and an agent set to never ask is held to ask wherever its tools are resolved: the gate's permission, the plane's providers (native search on claude-agent and codex stays off, as under ask), the agent's tools and a save's blockers. A PUT /v2/settings/tools replaces the file and lifts it. Upgrading: nothing to do.

A direct read of the settings file (learning's draft check, the learned-draft tools) carries the same mark, so it fails closed too.
