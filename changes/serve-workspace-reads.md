---
packages: @parcha/agentrun-serve, @parcha/pi-durable-disk
kind: fix
---
What serve reads out of a run's workspace never goes through a link, and never reads a file hard-linked in. That covers the files endpoint (`GET /runs/:id/files/:path`), the file listing, and each skill's `SKILL.md` at a run's start.
- Before, the file view checked each component with `lstat` and then opened the file by its path, so a name swapped for a link in between could hand it a file outside the workspace. The listing likewise `stat`ed by path.
- Now every read goes through pi-durable-disk's confinement, which walks on held directory handles without following links. The path must be the workspace joined with its own names, so a link anywhere on the way is refused, even one pointing inside the workspace. Only regular files with a single link are read.
- A file serve cannot read is listed with `unreadable: true` (a serve extension on `RunFile`), and reading it answers 403 `system_file_forbidden` with `details.reason` `unreadable`, never a 500. A tool in the run's box creates such a file when it makes it owner-only.
- pi-durable-disk exports `Confinement` and `confineHooks` from `@parcha/pi-durable-disk/internals`.
