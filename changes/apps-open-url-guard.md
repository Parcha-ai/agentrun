---
packages: @parcha/agentrun-computer
kind: fix
---
On a Linux desktop, `apps.launch` (a script's `computer.apps.open`) refuses a `url` that is neither an absolute URL with a scheme (`https://…`, `file:///…`) nor an absolute path, and starts nothing. Before, computerd put the `url` into the app's argv as it was: one starting with `-`, after leading whitespace too, reached the app as a flag (Chromium's `--renderer-cmd-prefix` runs a command, on a computer whose exec is off), and a relative path reached it as a file. A `url` starting with `-` is refused `invalid` in words of its own: `starts with "-": the app would take it as a flag, not a url`. The macOS and Android daemons already took only a URL with a scheme, handed to the OS rather than to an argv.
