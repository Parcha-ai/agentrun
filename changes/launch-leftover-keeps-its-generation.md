---
packages: @parcha/pi-transport
kind: fix
---
A process left over from an earlier launch of a name now does nothing once the name is launched again. The launcher's supervisor, watchdog and program runner took their generation from the spec they read when they started, so a supervisor that the earlier launch's watchdog started just as the name was launched again took the new generation as its own and acted in the new launch's directory: it could start a program that had exited there a second time. Each of these processes is now given the generation of the process that started it and keeps it; when the spec holds another one, it exits and writes nothing. The watchdog also checks its generation before it registers.
