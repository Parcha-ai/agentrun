---
packages: repo
kind: fix
---
The console's run timeline marks a failed tool call failed: it read a `tool_status` of `"error"`, which the open platform never writes, so a call that failed (or was interrupted) showed like one that succeeded. A workflow run's `decision` rows now read Decision with their own icon, and open to their cited sources and refused questions.
