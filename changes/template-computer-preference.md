---
packages: @parcha/agentrun-serve
kind: feature
---
A template can name the computer it prefers and fall back: `computer: [shell, none]` in its agent.md, read like `harness`. Apply takes the first entry this server meets now and saves it as the agent's `computer`: `shell` is Archil's serverless exec on the runner when Archil is on (Settings → Workspace; `bash` alone), else the Docker sandbox where Docker answers; `none` is no shell. With `none`, the shell tools in the package's `tools` and `tool_policy`'s bash are not granted, and a `computer` warning on the apply says so and how to get a shell. A list with `shell` alone, where there is none, refuses the apply (409, nothing made). `computer: default`, or no `computer`, keeps today's behavior. `GET /v2/templates` shows each package's `computer` list and `computer_here`, what an apply here would pick now.
