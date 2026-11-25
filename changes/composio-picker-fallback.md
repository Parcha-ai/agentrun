---
packages: @parcha/agentrun-serve
kind: fix
---
Add from Composio takes a typed toolkit slug again when Composio's toolkit list fails or leaves the toolkit out, and **Cancel** works while a list loads. A key edit or Cancel stops the load. The toolkit listing gives up after 30 seconds in all, and any Composio answer over 4 MiB is refused. Only an account Composio names as the server's user's connects a server, labels it, or runs its trigger: one Composio answers as another user's, or with no user at all, never does (`composio_not_connected`), and the user connects one again. A trigger on a server whose saved Composio user is blank is refused before Composio is asked anything; the server's own Composio routes (its events, its triggers, the project's subscription) and its delete still work. An account a refresh kept on 0.1.0-beta.57 or beta.58, which could be another user's, isn't shown: the server shows no account line until its next **Refresh**.
