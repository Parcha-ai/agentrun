---
packages: @parcha/agentrun-harness-acp
kind: fix
---
Under Antigravity, an MCP call that reaches AgentRun before agy's announcement of it no longer takes another call's id. This happens when the call's arguments match another call's except for the `toolSummary` that the other call sent. Such a call now holds for half a second (`ANNOUNCE_GRACE_MS`) before it takes an announcement it matches only without `toolSummary`. An announcement that arrives while a call waits is handed to that call only when its arguments match exactly. An announcement whose call ended without an MCP call is dropped, so it never makes a later call wait. A call that waited takes an announcement naming nothing that was already there when it came, once none of its own is left.
