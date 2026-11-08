---
packages: @parcha/agentrun-computer
kind: fix
---
A Docker computer runs a daemon that npm installed under any umask. Under `umask 077` npm installs `dist/computerd-linux-*` at 0700, and `DockerProvider.create` refused it ("chmod 755 it"). It now binds its own 0755 copy, named by the sha256 of the daemon's bytes, in a directory only this user may enter (the new `daemonCache` option; default `agentrun-computer` under `XDG_CACHE_HOME`, else `~/.cache`). The directory is made 0700 and checked before every bind: a link, another user's directory, a looser mode, or a directory above it another user may write is refused in words, never followed or changed. The drift check and `attach` compare the copy's path. A daemon this process cannot read is still refused in words.
