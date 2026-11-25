---
packages: @parcha/agentrun-serve
kind: fix
---
A connected account Composio lists with no `user_id` is no longer taken as the server's user's: a Composio save makes the connect link instead of standing on it, a **Refresh** shows the server as not connected (or `pending` while its own connect link is unfinished), and a run never binds it as its account.
