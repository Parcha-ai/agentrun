---
packages: @parcha/agentrun-serve, @parcha/agentrun-client, @parcha/agentrun
kind: feature
---
Settings → MCP servers → Add from Composio picks the toolkit from the list Composio offers (**Load toolkits**, then a picker by name and slug) instead of a typed slug, and a saved Composio server's row says whether its account is connected and which account it is once you press **Refresh**.
- `POST /v2/settings/mcp-servers/composio/toolkits` `{api_key}` answers `{toolkits: [{slug, name}]}`, every page of Composio's list (at most 20 pages and 8 MiB; a cursor Composio repeats ends it), sorted by name. It stores nothing and is the owner's session alone (403 to the API token), as the actions listing is.
- A refresh of a Composio server reads its account at Composio, and every read of the server then carries `composio_account: {state, labels?, checked_at}`: `connected` with each account's label (its alias, else the name Composio shows, else its word id; never its id or a token), `pending`, `expired`, `none`, or `unknown` when Composio didn't answer. An account Composio answers as another user's is never the server's. The API token sees it too, in a server's full read, and a label may be an email. A per-run server, a toolkit that needs no sign-in, and a server saved before its save recorded what it stands on have none.
- The picker takes no free entry: a toolkit Composio doesn't list can't be typed in the console (the API still takes any slug).
