---
packages: @parcha/agentrun-serve
kind: feature
---
In a Docker sandbox place on Linux, `read`, `write` and `edit` run on this server, on the `work/` the container binds, instead of as a `docker exec` each (half a second or more per call). `bash` still runs in the container, and a run that never calls it gets no container.
- The file tools take nothing a command in the box can plant. A link anywhere on the way is refused, one pointing inside `work/` included, and so is a file with another hard link. Every directory is walked on held handles (`/proc/self/fd`), so one swapped for a link between the check and the use is refused too. A write goes through a temporary file renamed over the old one, keeping its mode; a new file is `0644`. A refusal names the box's path and says that `bash`, in the box, can still reach the file.
- A run whose earlier process left its box (a crash mid-`bash`) has that box's leftover commands killed before its first `read`, `write` or `edit`, so none of them changes `work/` under the file tools. A fresh run still makes no box for them.
- The model still names and sees the box's paths (`/run/agentrun/run/work/...`), mapped one for one onto the bind's source.
- Where the server reaches directories by path (no `/proc/self/fd`, as on macOS), or the box binds nothing, all four tools run in the box as before.
