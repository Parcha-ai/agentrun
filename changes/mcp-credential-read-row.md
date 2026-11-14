---
packages: @parcha/agentrun-serve
kind: fix
---
A saved MCP server's credential is sent only to the address it was saved with. Listing a saved server (preview by name, refresh, a first run's pin listing, a save or a sign-in that keeps the saved credential) reads the server, then checks its address and waits for the listing. If the owner saved the server at another address with a new credential during that wait, the new credential could be sent to the old address. Each of these now opens the credential of the server as it read it.
