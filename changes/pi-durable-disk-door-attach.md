---
packages: @parcha/pi-durable-disk
kind: feature
---
A door hook may take `attach(emit)`, called once as the door opens: a turn the hook starts itself, with no submit (a recovery after a restart), reports its start and end on `GET /events` through it.
