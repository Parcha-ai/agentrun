---
packages: @parcha/agentrun-serve
kind: fix
---
On the runner, the timeline route serves each call that waits for an approval as the run's page does: the call held, then its one approval row, then what came of it. And on a server with accounts off, where no one can approve, an ask is refused at once in words ("needs the owner's approval, and this server has accounts off"), never parked; an agent whose approvals are "never" still runs a clean ask. Upgrading: nothing to do.
