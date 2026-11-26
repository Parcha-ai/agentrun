---
packages: @parcha/agentrun-computer, @parcha/agentrun-kernel, @parcha/agentrun-serve
kind: fix
---
On a Linux desktop, `apps.launch` (a script's `computer.apps.open`) refuses a `url` that is neither an absolute URL with a scheme (`https://…`, `file:///…`) nor an absolute path, and starts nothing. Before, computerd put the `url` into the app's argv as it was: one starting with `-`, after leading whitespace too, reached the app as a flag (Chromium's `--renderer-cmd-prefix` runs a command, on a computer whose exec is off), and a relative path reached it as a file. A `url` starting with `-` is refused `invalid` in words of its own: `starts with "-": the app would take it as a flag, not a url`. The macOS and Android daemons already took only a URL with a scheme, handed to the OS rather than to an argv.

The words every offer of a computer's ops carries (`GUI_REACH`) now say that `apps.open` with a URL or a path, not only a `file://` URL, reaches what the shell and the file ops do. serve's README and the desktop kind skill no longer say that every op the gate refuses whatever its arguments is left out of `computer_op`'s list: only the ops held to a tool (the file ops, `shell.run`, `processes.start`) are; apps and raw input stay.
