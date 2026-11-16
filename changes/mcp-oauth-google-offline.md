---
packages: @parcha/agentrun-serve
kind: fix
---
Signing in to a Google-backed MCP server asks for offline access, so it gets a refresh token and stays signed in. A sign-in whose authorization endpoint is on `accounts.google.com` adds `access_type=offline` and `prompt=consent`; every other authorization server's sign-in is unchanged.
