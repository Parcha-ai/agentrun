---
packages: @parcha/agentrun-dsl
kind: fix
---
A host's `reconcile` can settle an unknown shell effect whose `produces` interpolates the state. Dispatch named the files from the state the call started from (`out/{tag}.txt` became `out/t1.txt`), but the settlement hashed the template as written. It always found `out/{tag}.txt` missing, refused, and left the run unopenable. Reconcile now names the files from the state the call started from: the kept state whose digest the driver bound when the call started, or a value the host passed in `bind`, matched by the same digest. It never reads the current state. When no kept value has that digest (a run's first step with nothing bound, for instance), the settlement is refused with `RECOVERY_RECONCILE_FAILED` naming the template. `produces` with nothing to interpolate are hashed as before, and a journal written before this change settles on its next open.
