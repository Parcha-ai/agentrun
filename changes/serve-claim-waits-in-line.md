---
packages: @parcha/agentrun-serve
kind: fix
---
On a busy or slow disk, a runner no longer gives up a run the store had just claimed or renewed for it. A claim or renew that waited for SQLite's write lock was counted from when the runner asked, so a wait of 25 s or more ended the run with `claim_lost` (`not_renewed`) the moment the store answered, and the run sat idle until the store's fresh claim ran out 30 s later. On SQLite the runner now counts the claim from the time the store granted it, and still stops 5 s before the store's claim runs out. Postgres is unchanged: the runner cannot read the database's clock, so it counts from when it asked.
