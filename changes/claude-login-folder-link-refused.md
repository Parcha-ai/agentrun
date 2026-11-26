---
packages: @parcha/agentrun-serve
kind: breaking
---
Turning on Claude Code's login on this machine at AgentRun's own login (`place` `agentrun`) is refused (403 `forbidden`) where `<data>/claude-login` is a link, in words that name the link and what it leads to: the new Sign out removes that folder whole, so it is a folder AgentRun keeps itself and never a link into another tree. Who breaks: a server whose `<data>/claude-login` was made a link to a folder elsewhere. What to do: remove the link (move what it led to into `<data>/claude-login` if you want that login kept), then turn the mode on again.
