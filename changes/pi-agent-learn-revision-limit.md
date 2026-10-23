---
packages: @parcha/pi-agent-learn
kind: fix
---
A name that churns through many revisions keeps admitting new ones: only its live and restorable revisions (trial, active, superseded) count toward the limit of 32. When admitting a new revision would take `revisions` past the limit, the trial's retired and demoted revisions leave the list and keep only their digests in a new `refused` field. A digest there is refused like a demoted one, so a re-saved identical revision is not tried again. The field keeps the newest 128: when it is full the oldest digest leaves (with any kept use that names it) and may be tried again, so a full list never refuses an admission. A trial that keeps refusals holds only its live and restorable revisions from then on. Before, retired and demoted revisions filled the 32 slots for good, and once the last live revision was demoted every new revision was refused with `limit`, so a long learning stream could never serve a workflow under that name again.
- A trial.json written with `refused` does not parse in earlier versions, whose schema has no such field. A trial that never passes the limit is written exactly as before.
