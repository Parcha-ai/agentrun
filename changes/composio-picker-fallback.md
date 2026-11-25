---
packages: @parcha/agentrun-serve
kind: fix
---
Add from Composio takes a typed toolkit slug again when Composio's toolkit list fails or leaves the toolkit out, and **Cancel** works while a list loads. A key edit or Cancel stops the load. The toolkit listing gives up after 30 seconds in all, and any Composio answer over 4 MiB is refused. A connected account Composio answers with no user shows no labels, and an account Composio answers as another user's never connects a server's save or runs its trigger (`composio_not_connected`). An account a refresh kept on 0.1.0-beta.57 or beta.58, which could be another user's, isn't shown: the server says no account until its next **Refresh**.
