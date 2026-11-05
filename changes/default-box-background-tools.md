---
packages: @parcha/agentrun-serve
kind: feature
---
A new agent in the default Docker box that names no tools gets the background tools with its shell: `bash`, `bash_background`, `bash_output`, `bash_input`, `bash_signal` and `bash_list`. It can start a command that outlives one call (a dev server, a watcher, a long build) from its first run. A definition that names its tools, an empty list included, keeps exactly those.
- The README says what the background tools do not track: a child that leaves the command's process group (its own `setsid`, a daemon) is not counted, signalled or ended at the run's end. Only the box's end, its process limit and its 24-hour lifetime end it.
- The tool gate holds each background tool to `bash`'s setting, and the README and the source say so.
- A process whose runner ended before it did reads as gone, whether its box was replaced or its runner was killed.
