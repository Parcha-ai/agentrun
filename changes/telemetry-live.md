---
packages: @parcha/agentrun-serve
kind: feature
---
The server's anonymous usage counts are on. From this release, `agentrun-serve` sends `server_started`, a daily `heartbeat` and `first_run_completed`, each with a random id, the version, the platform and how many runs ended as a range: never a prompt, a file, a key or a name. The first start prints a notice on stderr and sends nothing. `AGENTRUN_TELEMETRY=0` or `DO_NOT_TRACK=1` turns the counts off, as do `CI`, a test runner (`node --test`) and `--faux`, and `AGENTRUN_TELEMETRY=debug` prints each event and sends none. Events go to `https://telemetry.agentrun.ai`, which forwards them to PostHog's US cloud, set to discard the sender's address. [docs/telemetry.md](docs/telemetry.md) lists every field.
