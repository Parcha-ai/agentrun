---
packages: @parcha/agentrun-serve
kind: fix
---
The API token can no longer drop or replace a secret, or start a sign-in whose credential the server keeps. Starting an MCP server's OAuth sign-in, removing an MCP server, saving one in a way that would drop or change the credential it holds (another auth type, or none), Connect GitHub, Disconnect GitHub and forgetting a saved browser sign-in now take the owner's signed-in session in the console, as saving a secret already did; the token gets 403 in the same words. A client kept from an earlier MCP sign-in is used again only at the authorization server it was registered at: when the MCP server names another one, the sign-in registers a new client there.
