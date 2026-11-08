---
packages: @parcha/agentrun-computer
kind: feature
---
The coding agent's shell, on computerd: `bash` and the five background tools (`bash_background`, `bash_output`, `bash_input`, `bash_signal`, `bash_list`) as functions of a computer's client, with their names, parameters, limits and words, and the tool gate's mapping (`SHELL_UNDER_ASK`, `shellPermission`) as data. Nothing calls them yet: the workspace wires them.
- `bash(client, {command, timeoutMs?, cwd?})` runs the command through `process.start` and `process.read`: 120 s by default, 600 s at most (a call asking more runs at 600 s and says so), killed with everything it started at its timeout, the end of its output kept (2000 lines or 50 KB) and the whole of a longer one saved to a file in the computer.
- The background tools are `process.start`, `read`, `write`, `signal`, `wait` and `list`, with no script run in the computer: an id is computerd's number for the process, a log is the process's last 8 MiB, `tty: true` is a computerd terminal (`close: true` types Ctrl-D), and `endBackground` ends every one still running at the run's end.
- `process.read` answers `size`, the stream's bytes so far, so a page says where it stands in the whole without reading to the end.
