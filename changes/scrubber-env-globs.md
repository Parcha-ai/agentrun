---
packages: @parcha/agentrun-serve
kind: fix
---
The scrubber now cuts a read of `.env` files named by a glob or a brace, such as `cat .env*`, `head .env.*` or `cat .env.{local,production}`. Before, these printed every file uncut. The dotfile exemption covers only a plain path, so these commands keep their `env` token and their output is an `env-dump` cut.

The env-dump reader now also catches:
- `process` with `.env` on the next line;
- the `Environment` property (`systemctl show -p Environment`) and `/etc/environment`;
- `heroku config` and its subcommands;
- `ps` with an uppercase `E` (`ps auxE`, `ps -E`).

A transcript's cut now also starts and ends at a full PS1 prompt: `user@host:~$`, `root@c:/#`, `[user@host dir]$`, with or without a `(venv) ` prefix.
