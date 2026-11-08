---
packages: @parcha/pi-durable-disk
kind: ci
---
The run journal's NORMAL preconditions mark the retry's lost-attempt mark as needing no barrier, with a box-loss guard that pins why: a capped pi request read after a box loss mid-retry counts at its hold whether or not the lost mark survived.
