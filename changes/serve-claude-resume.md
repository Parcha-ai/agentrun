---
packages: @parcha/agentrun-serve, @parcha/agentrun-harness-claude
kind: feature
---
A boxed claude-agent run gets its harness's own tools, and resumes a restored session in its box.
- Each launch of a boxed harness run's process gets a temporary directory of its own: `<run>/harness/proc-tmp/<launch>`, 0700, made step by step through no link, as the process's `TMPDIR`. The Agent SDK's config and resume directories are made there, inside the run's session.
- Each start of the CLI is lent only its own directories from it, its config directory and, on a resume, its resume directory. Neither may be a link, and each must sit directly under that launch's directory, or the start is refused by name. Nothing else there, a browser's profiles among it, is ever in a box.
- A launch removes an earlier launch's directory only once that launch's process is proven gone, by boot id and start time; it keeps any it cannot tell, and it is never refused for them. A launch whose process died before its record was written is one it cannot tell, so its directory stays until the run is removed.
- The session's sockets stay in serve's own temporary directory, one per launch, short enough for a socket's path.
- One run process holds one boxed Claude session: a second at once is refused by name, and the first's close, a failed open or its end lets the next one open.
- No reader of the run's files sees these directories: they are outside its workspace.
- A host that runs several Claude sessions in one process does not get them boxed.
