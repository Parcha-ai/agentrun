---
packages: @parcha/agentrun-serve
kind: breaking
---
An older server's learning records are no longer read: the reasons `no_write_tool`, `tool_denied`, `screen` and `screen_down` are gone from a run's learning reasons and the contract, and a ledger line with any of them is not counted in /v2/stats; a run's pin with only the index-only `learned` field gives the run nothing learned. Upgrading: runs recorded by a server before these were dropped show their old reason as stored and are not counted in the learning stats; nothing else to do.
