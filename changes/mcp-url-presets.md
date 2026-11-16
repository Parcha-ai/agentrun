---
packages: @parcha/agentrun-serve
kind: feature
---
Settings → MCP servers: the add form offers five URL presets above "Or any MCP URL", the servers the free templates use. Each one fills the name (the first free one), address, credential and toolkit, and shows a one-line note:
- Parallel Search (`https://search.parallel.ai/mcp`, no credential).
- Firecrawl (`https://mcp.firecrawl.dev/v2/mcp`, no credential): free without a key and rate limited. A Firecrawl key added later as a bearer token gives more.
- GitHub (token) (`https://api.githubcopilot.com/mcp/`, a fine-grained token as a bearer token). It has a Read-only switch for `https://api.githubcopilot.com/mcp/readonly`. It sits beside the GitHub App credential, which is unchanged.
- Linear (`https://mcp.linear.app/mcp`) and Notion (`https://mcp.notion.com/mcp`), with Sign in.

Preview and Save are the same as for any address. `#/settings/mcp?add=<name>&preset=<id>` (`parallel`, `firecrawl`, `github-token`, `linear` or `notion`) opens the form with that preset filled. A preset id that is none of these opens the plain form.

Choosing a preset clears a token, header rows, scopes or client typed for another server, so none of them goes to the preset's address. The presets wait until the saved servers have been read. A new server whose name is already saved can't be saved or signed in, because saving it would replace that server.
