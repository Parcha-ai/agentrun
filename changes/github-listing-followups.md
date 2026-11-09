---
packages: @parcha/agentrun-serve
kind: fix
---
A `github_app` MCP server's tools are listed with a token from the first of the App's installations that covers a repository, so an account with none selected no longer refuses every preview, save and refresh while another installation has one; each installation's scout token is revoked. GitHub that doesn't answer while that token is minted (a 429, a 5xx, a rate limit's 403, no answer) is now `502 github_failed`, "GitHub didn't answer: try again", retryable, and nothing stored changes; it was `409 github_not_connected`.
