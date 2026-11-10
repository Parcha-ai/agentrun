---
packages: @parcha/agentrun-serve
kind: fix
---
An MCP server signed in with OAuth stays signed in when its authorization server is slow. A token refresh is sent once per refresh lease: a try's own time bounds a request only until it is dialled, and once sent it is awaited within the refresh call's deadline and never sent again, so a provider that rotates refresh tokens and revokes a grant on their reuse never sees a spent one twice. A refresh is tried again only when it provably never left (a refused or unmade connection, or an address check out of time). A refresh that left and got no answer holds the lease to its end, and the next claim refreshes after it; an error answer that granted nothing (a 5xx) lets the lease go at once.
