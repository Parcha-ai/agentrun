---
packages: @parcha/agentrun
kind: fix
---
The CLI's edges, each said plainly:
- A body refused because the request's path, with the base URL's, ends like a secret route (`home write AGENT settings/tool-keys/x` with an inline body) now says so and names the route; pass the body on stdin or from a file.
- `runs start --wait` bounds its start as it bounds the wait: by `--timeout` (exit 1, with a line saying the run may have started and how to find it), else as one of the wait's requests is (exit 3).
- `runs timeline --follow` reports a stream event that is not a JSON object as the server's bad answer, exit 1, at once, not as a server it cannot reach.
- A `DIR/.server.json` whose `base_url` is no base URL is refused as a malformed record is, exit 4; a bad `--base-url`, `AGENTRUN_BASE_URL` or config `base_url` stays exit 2.
- `login` writes its config through a temporary file with a random name, opened only when it is new, and a config it cannot write is exit 4 with a plain message and nothing left behind.
- A run stopped at its spend cap prints a hint naming `agentrun runs raise-cap RUN_ID --max-cost-usd N`, N the server's `suggested_cap_usd`.
- `api --header` keeps every header name it can send, `constructor` included, and refuses `__proto__`, which Node's fetch would drop unsent.
- `skill install --codex`, and the default install for Codex, write `~/.agents/skills/agentrun-cli`, the user skills folder Codex reads (Cursor reads it too), not `$CODEX_HOME/skills`, which Codex marks deprecated. An older copy of the skill there is left in place, and the command prints one line naming it and the new copy. With no flag, it installs into each of `~/.claude` and `~/.agents` that exists.
