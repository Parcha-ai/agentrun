---
packages: @parcha/agentrun-serve
kind: fix
---
On a server with accounts off, where no one can approve, an ask is refused at once in words ("needs the owner's approval, and this server has accounts off"), never parked, by a runner on this machine or another: the server writes whether anyone can approve to its store at each start, and a runner reads it at each claim; an agent whose approvals are "never" still runs a clean ask. Upgrading: nothing to do.
