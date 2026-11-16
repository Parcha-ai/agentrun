---
packages: @parcha/agentrun-serve
kind: feature
---
A template package's `composio` trigger names its own Composio MCP need by its toolkit, as `mcp:<toolkit>/<tool>` names the need's tools: `source.server: github` for the need `{source: composio, toolkit: github, required: true}`. Apply makes the trigger on the saved Composio server that need resolves to: the one candidate, or the owner's pick under `servers.<toolkit>`. A package is portable again for Composio events, which #2961 took off the manual webhook way.
- A package whose composio trigger names no `source: composio` need of the package is refused when it is read (`422` at import), in words that say to name the need's toolkit.
- The need a composio trigger names is `required: true`: an optional need may have no saved server, and the trigger would have none. A required need with no saved server already refuses the apply (`409 agent_not_runnable`), so no trigger is made without a server.
- A composio trigger this server can't set up yet is skipped with a `not_set_up_here` warning under `triggers.<i>`, in the refusal's words, as a github trigger is with GitHub not connected: no public URL, no connected account (or several) for the saved server's user, or the project's subscription at another address. The agent stands, and the owner makes the trigger from Triggers → New app trigger once that's fixed. Any other refusal still undoes the apply. A template eval of a package with a composio trigger runs its cases on its own server, which has no public URL.
- A trigger made with `POST /v2/triggers` is unchanged: its `server` is still a saved Composio server's name.
