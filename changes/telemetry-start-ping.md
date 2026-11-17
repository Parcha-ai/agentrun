---
packages: @parcha/agentrun-serve
kind: feature
---
The server can count itself, anonymously: `server_started`, a daily `heartbeat` and `first_run_completed`, each with a random id kept in the data directory, the version, the platform and how many runs ended as a range. **This release sends nothing**: the receiver's key is not set, and the release that sets it will say so. `AGENTRUN_TELEMETRY=0` or `DO_NOT_TRACK=1` turns it off, as do `CI` and `--faux`; `AGENTRUN_TELEMETRY=debug` prints each event and sends none. [docs/telemetry.md](https://github.com/Parcha-ai/agentrun/blob/main/docs/telemetry.md) lists every field.
The start that first could send prints one notice on stderr and sends nothing at that start.
A send never delays a start, a run or a stop; a failed one is dropped.
