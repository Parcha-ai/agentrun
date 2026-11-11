---
packages: @parcha/agentrun-serve
kind: fix
---
A retired note, skill or workflow draft that waited for its owner's OK waits again when it is restored: a restore gives back the status it had before its retire, and only an approval makes it active. Before, Retire then Restore made a held rule active, and the restore was recorded as the owner's approval. A retire now records the status it took the item from (`retired_from: active | pending` in its front matter), the learning view says it (`retired.from`), and the console's Restore confirm says what the restore does: "It becomes active again" only for an item that was active, else that it goes back to waiting for your OK. A person's edit of a retired note keeps it retired with what its retire recorded, and a run's note may not set `retired_from`.
Upgrading: nothing to do.
