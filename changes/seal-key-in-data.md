---
packages: @parcha/agentrun-serve
kind: fix
---
The seal key now lives with the data. With no `AGENTRUN_SEAL_KEY`, the server keeps its key in `seal/seal.key` in the data directory, beside the store (0600 in a 0700 directory), made at the first start, so a disk or volume carries its key with it; back the two up together. The store records the key's fingerprint, and the server, every runner and `import` check the key they hold against it: a store whose secrets were sealed with another key does not start ("this store's secrets were sealed with another key; hand the server the original AGENTRUN_SEAL_KEY"), and a lost key file is never replaced by a new key over saved secrets. On Postgres a second machine with another key refuses the same way. Only the server's start makes a key; a runner reads it and never makes one. The launcher no longer makes or reads a key under the config home, and nothing reads one there: set `AGENTRUN_SEAL_KEY` explicitly, the same in every process.
