---
packages: @parcha/agentrun-serve
kind: feature
---
The owner approves a note that waits for their OK: `POST /agents/{agent_id}/learning/files/{file}/approve`, under If-Match, makes a pending note active, in MEMORY.md and read by every later run, and marks what it supersedes. Only the owner's signed-in console approves: the page's password session from this server's own origin with a JSON body. Every token is 403, the server's own included (a script's, an agent's MCP client's, the MCP endpoint's tools'), and so are a run's door token and every value a run's process holds; with no credential it is 401, as every route. With accounts off (`AGENTRUN_ACCOUNTS=0`) nothing approves, since the page's cookie there is minted from the token. `capabilities.learning.approve` says whether this server approves. The approval is one host commit with the `Changed-By: user` and `Approved-Via: console` trailers, and the learning log reads `by: {user: true, via: "console"}`, never the note's text.
