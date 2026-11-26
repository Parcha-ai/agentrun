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

A shared run's title now has one more env-dump cut. The title is the first message on one line, so `$ printenv` and its `NAME=value` output sat on the same line there and were shared uncut. The export now reads the title as a flattened transcript: after a prompt, when a command that prints the environment is followed by a `NAME=value` word, everything from that word to the next prompt is cut. This covers only that shape. Output that doesn't start with `NAME=` (`printenv NAME`, `echo $NAME`, `cat .env`, `docker inspect`, `heroku config`) is still carried in the title, though the row that holds the same message is cut. Only the title is read this way; a row or file keeps reading `$ env NAME=value command` as a command. A share host reads an uploaded bundle's title the same way.

A `.env` name in another case (`cat .ENV`, `cat .Env.local`) is now an env-dump. env-file matches only lower-case names, and the exemption used to drop these names anyway.
