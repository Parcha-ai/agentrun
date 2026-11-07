---
packages: @parcha/agentrun-computer
kind: fix
---
`process.signal` `INT` on a process started with a pty goes to its terminal's foreground process group, as ^C does at a terminal: it ends the job a shell runs in the foreground, and the shell reads on. It used to reach only the program's own group, which an interactive shell ignores while its job runs on. `TERM`, `KILL` and `HUP`, and `INT` without a pty, still go to the program's group.
- The daemon reads the foreground group from the terminal it holds (TIOCGPGRP) and sends `INT` to it through the program's guard only when that group is in the program's own session; a terminal the program handed to another session is refused as `denied`, and nothing is signalled.
- When the terminal has no foreground group (the program let go of it, or is ending), `INT` goes to the program's own group, and the reply, otherwise `{}`, says so in `note`.
- The conformance case `process.pty-interrupt` (Core, needs `processes` and `exec`) checks it through a provider.
