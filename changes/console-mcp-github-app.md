---
packages: @parcha/agentrun-serve
kind: fix
---
Settings → MCP servers in the console offers GitHub App as a credential, beside None, Bearer token, Headers and OAuth. Choosing it fills GitHub's hosted MCP address (the only one a GitHub App server may have), takes optional static headers, and saves `auth: {type: "github_app"}`; a server saved that way, through the API or the console, shows as GitHub App and is changed as one instead of falling back to None. A preview or save with no GitHub App connected says so in words and points to Settings → GitHub.
A template's Apply screen now says, before Apply, when an MCP server the template names is not set up here: a required one says Apply is refused until it is, an optional one says the agent is made without its tools, and each links to the add form with the server's name filled (the `github` server opens with GitHub App chosen), at `#/settings/mcp?add=<name>`. Applying the code review template no longer leaves an agent without its GitHub tools unseen.
