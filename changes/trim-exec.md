---
packages: @parcha/agentrun-computer
kind: fix
---
Modal's `kill()` now ends the exec's process in the machine, and every process under it, so Modal passes the exec pre-check's kill check. Daytona's exec runs on `framedExec`, the same code as the other split-call vendors, and reads a command's exit code once its log stream ends, so a bridge that runs for hours makes no calls while it runs.
- One kill-by-pid for every exec with no kill of its own: `PID_WRAPPER` and `pidKill` in `src/hosted/scripts.ts`, used by `framedExec`, the SSH exec (Agent37) and Modal. The SSH exec's own wrapper and pid file are gone, and its kill now reaches a child that left the process group as well as every process still in the group the command leads.
- `framedExec`: an `events` stream that throws fails `wait()` with its error (Daytona's failed exit-code read, in its words), where `wait()` used to answer -1.
- The Core case `provider.prepare-image` also checks that a provider's `prepareImage()` and its descriptor's `prepareImage` flag agree, before it calls `prepareImage` twice. A provider with the method and no flag now fails it: Settings never calls a method its descriptor does not declare.
