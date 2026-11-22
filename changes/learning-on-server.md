---
packages: @parcha/agentrun-serve
kind: fix
---
A server with Archil run disks (Mode 2) keeps every agent's learning folder in its own data directory, as a server without them does, and never on an Archil disk. Before, a Mode 2 run's end wrote its learning through Archil's serverless exec, which Archil runs only in its own AWS regions: on a server elsewhere every compile was dropped with "Archil refused to mount the exec's folders: 400 ValidationError: Exec is not enabled", so no workflow was ever learned or served. Now the run's end, the check, the reset and the agent's delete all use the folder in the data directory, which the server and the runners beside it on that directory share; two of them writing it at once lose nothing (two first commits at once included, which could fail one writer before), and one write at a time holds the folder (a lock with a lease, so a writer killed in the middle blocks the next one for at most 70 s), so an older commit's files and snapshot never land over a newer one's.

Upgrading: a learning folder an earlier Mode 2 server left on an Archil disk is not read, moved or deleted, by a reset, an agent's delete or a run's purge. The agent's learning starts again from its next runs, and that old folder can be removed with the disk. Resetting an agent's learning no longer answers `503` while Archil is off.
