---
packages: @parcha/agentrun
kind: fix
---
The CLI's edges, each said plainly:
- A body refused because the request's path, with the base URL's, ends like a secret route (`home write AGENT settings/tool-keys/x` with an inline body) now says so and names the route; pass the body on stdin or from a file.
- `runs start --wait` bounds its start as it bounds the wait: by `--timeout` (exit 1, with a line saying the run may have started and how to find it), else as one of the wait's requests is (exit 3). A `--timeout` longer than Node's longest timer (about 24.8 days) waits as long as it says.
  - Upgrading: a start that once waited without end now gives up at the bound; pass `--timeout` for a bound of your own.
- `runs timeline --follow` reports a stream event that is not a JSON object (null and a list included) as the server's bad answer, exit 1, at once, not as a server it cannot reach.
  - Upgrading: a script that read exit 3 for a malformed stream reads exit 1.
- A `DIR/.server.json` whose `base_url` is no base URL is refused as a malformed record is, exit 4; a bad `--base-url`, `AGENTRUN_BASE_URL` or config `base_url` stays exit 2.
  - Upgrading: a script that read exit 2 for a bad server record reads exit 4.
- `login` writes its config through a temporary file with a random name, opened only when it is new, and a config it cannot write is exit 4 with a plain message and nothing left behind. It writes every byte and syncs the file to the disk before the rename, so a full disk or a quota leaves the old config as it was.
- A run stopped at its spend cap prints a hint naming `agentrun runs raise-cap RUN_ID --max-cost-usd N`, N the server's `suggested_cap_usd`.
- An `Accept` given with `api --header`, in any case, is the one sent, alone; without one the default (`application/json, */*`) goes, and the token's `Authorization` is always set last.
  - Upgrading: `api ... --header 'Accept: ...'`, once overridden or merged with the default, is sent as given.
- `api --header` keeps every header name it can send, `constructor` included, and refuses `__proto__` in any case, which Node's fetch would drop unsent.
  - Upgrading: `--header '__proto__: ...'`, once dropped unsaid, is exit 2.
- `skill install --codex`, and the default install for Codex, write `~/.agents/skills/agentrun-cli`, the user skills folder Codex reads (Cursor reads it too). With no flag, it installs into each of `~/.claude` and `~/.agents` that exists.
  - Upgrading: a copy installed earlier in `$CODEX_HOME/skills/agentrun-cli` (default `~/.codex/skills`) is not touched or read by the CLI; remove it by hand.
