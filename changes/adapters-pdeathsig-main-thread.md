---
packages: @parcha/agentrun-adapters
kind: fix
---
`parentWatched` refuses the kernel's parent-death signal off the main thread. The kernel sends that signal when the thread that spawned the child exits, not the process, so a child a worker thread spawned under `setpriv --pdeathsig` would die the moment that worker ended. Called from a worker thread, `parentWatched` with `pdeathsig` (also the default on Linux with setpriv) now throws `PdeathsigOffMainThread` before anything is spawned. The shim watches the process and works from any thread. Nothing in the packages spawns from a worker thread today; this keeps it that way.
