---
packages: @parcha/agentrun-serve
kind: fix
---
The Composio preset reads a toolkit's actions at its latest version, and a save refuses an action Composio doesn't list before it makes anything there.
- `POST /settings/mcp-servers/composio/tools` asks Composio for `toolkit_versions=latest`. Without it Composio lists the toolkit's base version, which leaves out actions added since (on 2026-11-18 Linear listed 21 of 48 and Stripe 33 of 435), so the picker didn't offer actions templates use, such as `LINEAR_LIST_ISSUES_BY_TEAM_ID`.
- `PUT /settings/mcp-servers/{name}/composio` reads the same list, every page, before it makes an auth config, an MCP server or a connect link. A slug that isn't on it is `422 input_invalid` with reason `not_found` under `tools`, naming each such slug and the likely one when it is obvious ("ad (did you mean add?)"; a slug past 128 characters by its first 64 and its length), and nothing is made at Composio. `not_served`, for an action Composio allows but its server leaves out, is unchanged.
