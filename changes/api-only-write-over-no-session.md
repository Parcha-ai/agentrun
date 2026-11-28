---
packages: @parcha/agentrun-serve
kind: fix
---
On an API-only server, a token's save over or delete of an MCP server it did not save (or one that keeps a credential) is refused (403) in words that end at "Use another name." They no longer say to change it from the owner's signed-in session, which an API-only server does not have. No secret-write refusal there carries a console link any more (`details.console_url`, "Finish it in the console: …"), since an API-only server serves no console. The other refusals there name no session either: a credential's value sent by the token says to save the MCP server as `per_run` with each run's `mcp_auth`, or to name a Composio key by `api_key_env`, and a Composio listing that sends a key says to name it by `api_key_env`. The OpenAPI `forbidden` description says `details.console_url` is absent on an API-only server. A full server's refusals are unchanged.
