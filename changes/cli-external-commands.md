---
packages: @parcha/agentrun
kind: feature
---
`agentrun NAME [args]` runs `agentrun-NAME` from `PATH` when NAME is none of the CLI's own commands, as git runs `git-NAME`: the rest of the arguments go to it as given, with no shell, on the terminal's input and output, and its exit code is the CLI's. A tool adds a command by installing `agentrun-NAME`. It never replaces a built-in command, and a relative or empty `PATH` entry is never searched.
