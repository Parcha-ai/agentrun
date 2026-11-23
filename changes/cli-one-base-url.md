---
packages: @parcha/agentrun
kind: fix
---
Every command takes the server's address with or without `/v2`: `--base-url`, `AGENTRUN_BASE_URL` and the config file's `base_url` get `/v2` added when the address's path holds no `v2` segment, as `--to` already did, and a path prefix is kept (`https://host/prefix` is `https://host/prefix/v2`). Before, an address without `/v2` sent every command but `deploy --to` and `login --to` to the wrong path.
- The token in the config file is found for its address with or without `/v2` (a config written by `agentrun login --base-url https://host` still works with `https://host/v2`), and only for that origin and path. `agentrun login` now keeps the address with `/v2`.
- The device sign-in takes only a short user code: 1 to 32 printable characters with no space. A server that sends anything else is refused before any code is shown, and nothing is written.
- On a terminal, `agentrun login --base-url` to a server that can't be reached (exit 3), that offers its sign-in over http off this machine (exit 2), or that redirects or sends a malformed offer (exit 1) exits with that code, as `--to` does. Before, each exited 2 with a second line about typing a token.
