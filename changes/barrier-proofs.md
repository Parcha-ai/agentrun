---
packages: @parcha/pi-durable-disk
kind: ci
---
Every active barrier in `barriers.ts` names its proof: the one end-to-end test that loses a box while the effect it guards is in flight and shows the effect is not sent again. The barriers test fails when an active barrier names none, or names a file that does not exist; a barrier with no proof yet says so (`proof: null`), which keeps the run's store from going NORMAL. Four more conditions for that move are listed: a lost attempt's mark synced before pi-ai's retry, refused and unsent ends synced, a barrier for browser calls, and a proof for every barrier.
