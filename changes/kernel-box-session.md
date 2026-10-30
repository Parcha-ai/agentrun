---
packages: @parcha/agentrun-kernel
kind: feature
---
A box binds under serve's data root and the server's home only what is its own.
- **`BoxSpec.session`** names the one directory the machine lent the session. The workspace and every home must lie at or under it, and it may never be or hold a hidden path, such as a run's store or process log.
- **Writable binds.** Under the data root, the server's home or a CLI's config, a writable bind must be the session's or one of the spec's own sockets, and only while the session lies under the data root. A CLI's config is never bound.
- **Read-only binds under the server's home** are allowed only in node's install prefix, in the kernel's own packages or as its forwarder. These are computed from the running server, never from a spec. A prefix holding `etc/npmrc` is refused by name, since that file can hold registry tokens.
- A box whose spec breaks any of these is refused before it starts, by name.
