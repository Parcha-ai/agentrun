---
packages: @parcha/agentrun-serve
kind: fix
---
The background tools no longer trust files in `work/background/`, which the run's own file tools can write. Before, a pid written there was a group `bash_signal` and the run's end would signal (a forged `1` meant every process in the box), and a link planted at `output.log`, `command`, `started` or `exit` read another file of the box. A link planted at `ended` was a file the run's end truncated.
- The group, the exit code, the start time, the command and the run's-end mark are now kept in the box's own directory, out of `work/`. The files in `work/background/<id>/` are display copies that no call reads back, each renamed over its name so a planted link is replaced and never followed.
- `output.log` is opened first and checked as opened: it must be the log itself by its real path, and a regular file. Every read is then of that open file, so a link swapped in after the check is never read. A link planted at it is refused in words.
- A directory made in `work/background/` that the box did not start reads as gone and is never signalled.
