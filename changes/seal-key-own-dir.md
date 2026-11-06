---
packages: @parcha/agentrun-serve
kind: fix
---
The launcher no longer refuses the seal key it has just made. When `~/.config/agentrun` (or `$XDG_CONFIG_HOME/agentrun`) already exists with a mode other users can read, as a plain `mkdir -p` leaves it, and holds no key yet, the launcher tightens that directory to 0700 before writing the key, but only if the directory belongs to the user running it. A key that already exists is never changed: one in a directory other users can read is still refused, with the fix named (`chmod 700 <dir>; chmod 600 <dir>/seal.key`).
