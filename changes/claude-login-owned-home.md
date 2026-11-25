---
packages: @parcha/agentrun-serve
kind: fix
---
Claude Code's login on this machine now uses a home the server's own user owns: the server's `HOME` when that user owns it, else that user's own home. A server started under a sudo that keeps `HOME` no longer signs Claude Code in as root inside the person's home, leaving files their own CLI can't read, and a service account that inherited someone's `HOME` no longer reads that person's login as its own. Where the server's user owns neither, Settings says why, the turn-on and the sign-in are refused in those words, and a login saved before is turned off at the start.

The refusal of a box agent on Claude Agent that names no model, while the login is on, offers the move to the runner by the model the agent would run there: the host's default for Claude Agent, `AGENT_MODEL` first. Where that is Anthropic's own, the refusal now says the login runs agents on the runner only and carries `details.login_on_runner`, as it does for an agent that names Anthropic's model itself. Before, the refusal named a key and offered no move. Where it is an OpenRouter model, no move is offered, since the moved agent would still need OpenRouter's key.
