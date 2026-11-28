---
packages: @parcha/agentrun-serve
kind: fix
---
On an API-only server, a workspace's save or delete of an MCP server over a row of its name that its token did not save is refused (403) in the same words as every other token write over a saved server: they name the server and say the token did not save it. Before, it got the secret-write words ("Saving, replacing or removing a secret takes the owner's signed-in session…"), though the request sent no secret.
