---
packages: @parcha/agentrun-kernel
kind: ci
---
The kernel's faux adapter (`@parcha/agentrun-kernel/testing`) can ask the host's gate before each call, as a real CLI's tool bridge does (`gate: true`). A denied call answers in its words. A parked call waits, unrun, until the turn is stopped, and the next turn issues it again. `parkHeldUntil` keeps a stopped turn open until a file exists, like a CLI that is slow to stop. With it, serve's test for an approval that lands before a parked turn is let go runs on codex and claude-agent, and passes the same way on every run.
