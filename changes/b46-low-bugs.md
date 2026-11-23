---
packages: @parcha/agentrun, @parcha/agentrun-serve
kind: fix
---
Four smaller fixes from review:
- `deploy/fly/launch.sh` stops before it makes a secret when `fly secrets list --json` has entries without a `name` (a flyctl that spells it `Name`). Before, such a list read as no secrets, and a run on an app that had them made a new seal key and token over them.
- `install.sh --vps` no longer tries dpkg's lock again after apt-get's own 600 s wait for it, so a stuck dpkg stops the install instead of holding it for about 20 hours. The package lists' lock is still tried again for up to 600 s.
- When an earlier version's data stops a start in a folder the installer set up, the refusal says that moving the folder takes the installed agentrun with it (its Node in `node/`, `lib/` and `bin/agentrun`) and to run the installer again.
- `GET /v2/openapi.json` names the owner's session cookie as the console sets it: `agentrun-<port>-session` for the port the browser opened, or `__Host-agentrun-session` over https. It named `agentrun-<port>` for the server's own port, which no owner-only route takes.
