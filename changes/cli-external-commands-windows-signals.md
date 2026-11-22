---
packages: @parcha/agentrun
kind: fix
---
External commands (`agentrun NAME` running `agentrun-NAME` from `PATH`) are found on Windows and pass on every signal sent to `agentrun`.
- On Windows, `agentrun-NAME` is looked up with each extension in `PATHEXT` (`.COM;.EXE;.BAT;.CMD` when it is unset), in order, matched in any case, in each absolute `PATH` folder, with no execute-bit check. Before, no command was found there, since the lookup wanted a file with no extension and an execute bit.
- A batch file (`.bat`, `.cmd`) found that way is refused with a message, exit 126: Node runs one only through `cmd.exe`, which reads the arguments again, and agentrun runs no command through a shell.
- A SIGINT or SIGQUIT sent to `agentrun` alone (`kill -INT PID`) now reaches the command, as SIGTERM and SIGHUP already did; before, it was held and never passed on. A terminal's Ctrl-C reaches the command twice (from the terminal, and passed on), which a program handles as one Ctrl-C.
