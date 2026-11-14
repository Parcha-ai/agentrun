---
packages: @parcha/agentrun-serve
kind: fix
---
Deleting a Composio preset server in Settings → MCP servers also deletes the MCP server the preset made in your Composio account, using the saved key, so nothing is left behind there. Composio saying it is already gone is fine; if Composio refuses or does not answer, the server is still forgotten here and the answer (`200 {deleted: true, composio: {removed: false, note}}`) and the console say what to remove in Composio yourself. Any other server is deleted as before (204).

Saving a Composio server whose picked actions Composio serves none of (HACKERNEWS_GET_FRONTPAGE, say) now answers 422 naming those actions, instead of a bare 424 "Method not found", and the server it made on Composio is removed again. Only the server's own "Method not found" answer says that: Composio's MCP server being down, slow or erroring still answers 424. A preset server whose saved key can't be opened here is still forgotten, and the answer says to remove it in Composio yourself. The Composio server is deleted only after our row's checked removal succeeds, and is the one that row named.

The generated TypeScript and Python clients now type an operation that documents 204 beside a 2xx body as the body or nothing (`X | undefined`, `X | None`).
