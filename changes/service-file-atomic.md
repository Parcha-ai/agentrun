---
packages: @parcha/agentrun
kind: fix
---
`agentrun service install` writes the service file (the systemd unit or the LaunchAgent) whole or not at all, readable by its owner alone (0600): it writes a new file beside it and renames it over the old one, so a crash mid-write leaves the service as it was. A file an earlier install wrote 0644 becomes 0600 on the next install. `--env AGENT_MODEL_BASE_URL=` with a user name or password in the address is refused without repeating it: a key goes in the console (Settings → Model keys), never in a service file.
