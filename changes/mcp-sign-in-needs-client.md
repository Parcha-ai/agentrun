---
packages: @parcha/agentrun-serve, @parcha/agentrun-client, @parcha/agentrun
kind: feature
---
An MCP server whose sign-in lets no app register itself (GitHub's hosted MCP, whose login has no dynamic client registration) is no longer a dead end. Starting its sign-in with no Client ID is 422 on `client_id`, reason `registration_unavailable`: "<host> doesn't let apps register themselves: create an OAuth app with that provider and enter its Client ID and Secret here". GitHub is named for its hosted MCP. A preview of such a server says so up front, as `details.oauth.registration: false` on its `auth_required` refusal.

The console's MCP server form acts on either one. It turns to Sign in with OAuth, shows the Client ID and Secret fields and puts the cursor in the Client ID, and says what to do: create an OAuth app with the provider, using this server's callback URL, then enter its Client ID and Secret. A saved server whose sign-in is refused this way offers "Enter a Client ID".
