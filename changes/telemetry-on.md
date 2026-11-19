---
packages: repo, @parcha/agentrun-serve
kind: feature
---
The server now sends anonymous usage counts ([docs/telemetry.md](https://github.com/Parcha-ai/agentrun/blob/main/docs/telemetry.md)): `server_started` from its second start, a `heartbeat` every 24 hours, and `first_run_completed` once per data directory. Each holds a random id made for the data directory, the version, the platform (`os`, `arch`, Node's major version) and how many runs ended there as a range: never prompts, files, keys, names, paths or addresses.
- The first start that can send prints a notice on stderr and sends nothing until its first heartbeat a day later. A first run that completes before then is said with that heartbeat or at the next start, so the notice comes before anything leaves.
- Turn it off with `AGENTRUN_TELEMETRY=0` or `DO_NOT_TRACK=1` where the server starts. It is already off in CI (`CI` set), under a test runner (`node --test`), under `--faux`, and in every command but the server's start.
- `agentrun service install` writes `AGENTRUN_TELEMETRY` or `DO_NOT_TRACK` from the shell it runs in into the service, which never sees that shell, and `AGENTRUN_TELEMETRY=0` under CI. `--env` takes both names, and `--env KEY=` removes one. The installer's `--vps` writes them into `/opt/agentrun/.env` the same way: a value set where it runs replaces the line `.env` has, so running it again with `AGENTRUN_TELEMETRY=0` turns the counts off.
- `AGENTRUN_TELEMETRY=debug` prints each event on stderr in the form it would be sent, sends none and writes nothing.
- Events go to `telemetry.agentrun.ai`, PostHog's managed proxy under this project's own name, and land in a PostHog project on its US cloud that holds these counts and nothing else. The project is set to discard the sender's address, and its location lookup is off.
