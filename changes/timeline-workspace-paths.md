---
packages: @parcha/pi-durable-agent, @parcha/agentrun-serve
kind: fix
---
A run's timeline names a file by its path in the run's workspace (`Wrote hello.md`, `Saved hello.md`), even when the call named it by an absolute path there, as the Claude CLI does. Before, a claude-agent run's write rows read `Wrote <data>/runs/<id>/work/hello.md`. A path outside the run's directory stays as the call gave it, and the call's arguments, its input preview and what the store keeps are unchanged.
- `@parcha/pi-durable-agent`: `TimelineOptions.path`, how a row names a file path a call gave (`path`, `file_path`) or saved. Both the stored view (`timelineOf`) and the live one (`timelineReducer`) take it. Default: as given.
- serve passes F20's rule against the run's `work/`: relative to it inside the run's directory, as given elsewhere.
