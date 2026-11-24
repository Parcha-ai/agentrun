---
packages: @parcha/agentrun-serve, @parcha/agentrun, @parcha/agentrun-client
kind: feature
---
The owner can now make API keys for their apps in the console, under Settings → AgentRun API keys. Before, the only credentials were the tokens the server was started with (`AGENTRUN_TOKEN`, `AGENTRUN_TOKENS` or `DIR/.token`), so there was no way to get an `AGENTRUN_API_KEY` from the console.
- `POST /v2/settings/api-keys` with `{name}` answers the key once, as `api_key` (`ar_key_` and 32 random bytes). `GET /v2/settings/api-keys` lists each key's name, when it was made and when it was last used, never a key. `DELETE /v2/settings/api-keys/{api_key_id}` revokes one: the next request that carries it is `401`.
- A key opens what a token opens on `/v2` and `/mcp`. It is never the setup code.
- Making and revoking are secret writes: the owner's signed-in session alone. A token, or a key, gets `403 forbidden` with the console page in `details.console_url`.
- The server keeps a keyed hash of each key, never the key. A key that turns up in a run's text, a shared transcript or a learned note is cut by its shape (`ar_key_` and 43 or more base64url characters, a capital or a digit among them), whatever stands before it, since the server holds no value to cut it by.
- A key is one more caller that starts runs, as a second token is. A server with Claude Code's login on makes no key, and a server with a key refuses to turn that login on until the key is revoked (`403 forbidden`, in words, each way). On a server started with `--harness-sign-in` a key opens nothing, and is still listed so its owner can revoke it. An API-only server takes no key and serves none of these routes.
- A server keeps at most 50 keys; the next create is `409 api_keys_full`. Capabilities say `features.api_keys`. A request a key opened is logged with `api_key=<id>`.
- The CLI gains `agentrun api-keys list`. A suggested agent's pull request and the Playground's code pane now link to the page that makes a key.
