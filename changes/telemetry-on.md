---
packages: repo, @parcha/agentrun-serve
kind: feature
---
The server now sends anonymous usage counts ([docs/telemetry.md](https://github.com/Parcha-ai/agentrun/blob/main/docs/telemetry.md)): `server_started` from its second start, a `heartbeat` every 24 hours, and `first_run_completed` once per data directory. Each holds a random id made for the data directory, the version, the platform (`os`, `arch`, Node's major version) and how many runs ended there as a range: never prompts, files, keys, names, paths or addresses.
- The first start that can send prints a notice on stderr and sends nothing. A later start sends.
- Turn it off with `AGENTRUN_TELEMETRY=0` or `DO_NOT_TRACK=1` where the server starts. It is already off in CI (`CI` set), under `--faux`, and in every command but the server's start.
- `AGENTRUN_TELEMETRY=debug` prints each event on stderr in the form it would be sent, and sends none.
- Events go to `telemetry.agentrun.ai`, a Cloudflare Worker ([deploy/telemetry/worker.js](https://github.com/Parcha-ai/agentrun/blob/main/deploy/telemetry/worker.js)) that sends PostHog the listed fields alone and none of the request's headers, so PostHog never gets the server's address. They land in a PostHog project that holds these counts and nothing else.
- `npm test` (scripts/test-workspaces.mjs) runs its servers with `AGENTRUN_TELEMETRY=0` unless the shell sets it.
