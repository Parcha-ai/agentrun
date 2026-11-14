---
packages: @parcha/agentrun-computer
kind: fix
---
A `ui.act` with a `set` waits out its 500 ms hold on the clock before it reads the value back. Before, one timer of 500 ms could fire a millisecond early, so the readback could come before the hold was over.
