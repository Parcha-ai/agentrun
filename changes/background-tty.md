---
packages: @parcha/agentrun-serve
kind: feature
---
`bash_background` takes `tty: true` to run its command on a terminal: `script -qfec` in the box gives it a pty, so a program that needs one (a prompt, a REPL, a progress display) works in the background.
- Paging, input and signals are the same calls. The log holds what the terminal shows, with input echoed and lines ending in `\r\n`. `bash_input` types into the terminal. `bash_signal` reaches the terminal's processes, and `INT` is Ctrl-C.
- A box with no `script` (util-linux) refuses `tty: true` in words and starts nothing. `bash_list` marks a terminal process `(tty)`.
