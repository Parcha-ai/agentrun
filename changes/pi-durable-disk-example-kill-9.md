---
packages: @parcha/pi-durable-disk
kind: docs
---
**An example: a coding agent that survives `kill -9`**
- `examples/kill-9` runs on a directory of this machine with pi-ai's faux model (no disk, no key, Linux). An agent writes
  files in `work/`, is refused a write outside it, and starts a long `bash` command; the process is `SIGKILL`ed in the
  middle of it. A second process opens the run, which ends the command the first left running; the files are intact, the cut
  command comes back `interrupted` and is not run again, and the agent finishes. It ends with one `ok:` line, and `test/examples/kill-9.test.ts` runs it on every change.
