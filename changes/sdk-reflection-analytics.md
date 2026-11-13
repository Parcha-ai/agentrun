---
packages: @parcha/agentrun-serve
kind: fix
---
Include server-side reflection costs and tokens in completed SDK runs' analytics. Unknown costs and token counts remain unknown, and resuming an interrupted run reuses saved reflection without charging or counting it twice.
