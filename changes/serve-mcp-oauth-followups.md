---
packages: @parcha/agentrun-serve
kind: fix
---
An MCP server's OAuth sign-in sends nothing to a private or link-local address even when the MCP server is on loopback: a loopback server's authorization server may be on loopback, and only there; a failed start names the endpoint and its HTTP status, never what the authorization server answered. A refresh the sign-in server doesn't answer is tried twice and keeps the refresh token; an access token already past its expiry is never sent, and the call reads "the sign-in server didn't answer; try again". A credential that can't be used reads "The MCP server <name>'s credential can't be used right now: <reason>", each reason with its own remedy (update it, sign in again, or try again).
