---
packages: @parcha/agentrun-serve
kind: breaking
---
Security: an MCP server's credentials stay out of what anyone reads, and its address is held to the private-address rule at every door. Breaking, three ways:
- An MCP server on loopback (`http://127.0.0.1`, `localhost`) is taken only by a server started with the new `AGENTRUN_MCP_ALLOW_LOOPBACK=1`, which says this is a local install; it is never inferred from where the server listens. Without it such a URL is refused at the save, the preview and the sign-in, in words naming the variable, and runs never reach one. To upgrade: on a machine you alone use, start AgentRun with `AGENTRUN_MCP_ALLOW_LOOPBACK=1`.
- An MCP server's URL is shown on every read (the list, a server's read, a save's answer, errors) as its origin and `/…`: its path and query are held as a secret, sent only to the server itself. Sending the shown URL back for a saved server keeps the saved one. A client that read the whole URL back reads its origin now.
- A saved MCP server whose URL names a credential-like parameter in its query, or sits on a private network the owner hasn't listed, is refused from this release on (its preview, tools refresh, sign-in, and a run's claim). To upgrade: move a query credential into the server's Headers, and add a private host you use to the MCP private-hosts list (PUT /v2/settings/mcp-servers/oauth/private-hosts, which now covers the server's own URL too) over https.

And:
- A URL whose query names a credential-like parameter (`token`, `api_key`, `secret`, `signature`, `password` and the like) is refused at the preview, the save and the sign-in's start: "<name> in the URL's query looks like a credential; send it as a header instead (Headers)."
- The server's own URL goes through the same private-address rule as its sign-in's endpoints, at the preview, the save, the tools refresh, the sign-in and, on the runner, every request, dialled at the address checked: a private-network host only when the owner lists it, over https; link-local and cloud metadata addresses never; a 6to4 address judged by the IPv4 address it carries.
- A claimed run's calls follow the server's row: a server removed since is refused unsent, a replaced credential is the one sent, a token another run refreshed is the one sent, and an access token near its end is refreshed before the call. Removing an OAuth server revokes its refresh token at its authorization server (RFC 7009, best effort).
- Every credential value a run's MCP opens, refreshes or mints joins the run's one redactor, so it is cut from its logs and errors as well as from its tool answers.
