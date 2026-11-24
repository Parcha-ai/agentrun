---
packages: @parcha/agentrun-computer
kind: fix
---
Groundbox: a write or kill waits for the start's own readiness line, so a wrapper's warning on stderr no longer lets one go before the command's directory is made, and the line is taken off the command's stderr. A write to a command that has ended but whose fifo is still there no longer waits out the step for a reader.
