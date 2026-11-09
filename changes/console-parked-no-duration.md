---
packages: repo
kind: fix
---
The console's timeline shows no duration on a tool call parked for the owner's approval: its result row has no status yet (`tool_status: null`), and the time to that row is no run of the tool. A finished call, succeeded or failed, keeps its duration.
