---
packages: @parcha/agentrun-serve
kind: fix
---
A run read while its start was still copying its agent's learning (a runs list, the console polling, a poll of the run, a trigger's check, a replayed create) could be read from disk as a run a stopped server had left mid-copy: its learning copy was taken back ("its server stopped while it copied what its agent learned") and the live run lost its pin. A run this server is starting is now held by its start until it is set up, and every read waits for it instead of reading it from disk; the copy is taken back only for a run an earlier server started. Upgrading: nothing to do.
