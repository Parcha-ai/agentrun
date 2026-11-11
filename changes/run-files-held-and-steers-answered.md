---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel
kind: fix
---
Runs on the runner behave as before the cutover in four places a person could hit:
- A run keeps the files it was started with. The server holds each of a run's `file_ids` for it at the start, so a file deleted between the start and the runner's claim is still copied into the run's `inputs/`. The hold goes once the copy is made, or when the run ends without one.
- A copy of a run's files that fails ends the run failed with "The run's files could not be copied into its workspace: <why>", instead of the bare error.
- A message sent while a turn works is answered before the run ends. The runner hands a turn's end every message it has not handed on yet, rather than at its next poll half a second later, so the run's end no longer refuses one the API took. On pi, a message placed as the turn answered was answered after the run's end was written: the run read completed, then wrote another answer.
- A claude-agent run's rows name a file it wrote or read by its name in the workspace (`Wrote hello.md`, `Saved hello.md`), not by the absolute path the Claude CLI sends, which named a folder on the runner's machine. The call's input preview keeps the path as sent.
- The test kit's faux adapter tells its script the session's working directory (`script(spec, { cwd })`), as a real CLI builds its absolute paths from it.
