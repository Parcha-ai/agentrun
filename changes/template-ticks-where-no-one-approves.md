---
packages: @parcha/agentrun-serve
kind: fix
---
On a server where no one can answer an ask (accounts off, as on an API-only server), a template applied under approvals `ask` now writes `allow` into the agent's own tool settings for each MCP tool the apply grants, so its runs can call those tools. Before, a grant wrote no permission there either: each granted tool stayed at ask, which such a server refuses at once ("needs the owner's approval ... so no one can give it"), and every run that called one failed. `agentrun deploy` reported those tools as "grant ... allowed" all the same. A tool this server denies at the apply gets no allow, and keeps its deny. A pin whose parameter was left empty keeps its deny too. A server with accounts on is unchanged: a grant writes no permission, and a write asks the owner. Under approvals `never` nothing is written, since the gate already runs a granted tool unasked.
