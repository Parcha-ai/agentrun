---
packages: @parcha/agentrun-serve
kind: fix
---
An MCP server's credentials stay out of its URL and out of what a run keeps, and its address is held to the private-address rule at every door.
- A URL whose query names a credential-like parameter (`token`, `api_key`, `secret`, `signature`, `password` and the like) is refused at the preview, the save and the sign-in's start: "<name> in the URL's query looks like a credential; send it as a header instead (Headers)." Any other query is the server's own.
- The server's own URL goes through the same private-address rule as its sign-in's endpoints, at the preview, the save, the tools refresh, the sign-in and, on the runner, every request: a private-network host only when the owner lists it, over https; loopback, link-local and cloud metadata addresses never; a loopback server only on a local install. A refused URL is refused before anything is sent.
- A claimed run's calls follow the server's row: a server removed since is refused unsent, a replaced credential is the one sent, and an access token near its end is refreshed before the call. Removing an OAuth server revokes its refresh token at its authorization server (RFC 7009, best effort).
- Every credential value a run's MCP opens, refreshes or mints joins the run's one redactor, so it is cut from its logs and errors as well as from its tool answers.
- A sign-in with no Client ID says up front when its provider lets no app register itself (GitHub's hosted MCP among them): 422 on `client_id`, reason `registration_unavailable`; a preview of such a server says `details.oauth.registration: false`.
