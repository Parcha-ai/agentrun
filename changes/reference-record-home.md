---
packages: repo
kind: feature
---
A place whose child writes its recording inside the place brings it home through `Place.recordHome { dir(attempt), bringHome(into, { final }) }` (blobs first, then whole spool lines): the supervisor drives it at each status tick and once final, before the follower closes, the manifest and the release; a failure writes `recording.carry.failed`, refuses the recording only for an attempt that ended on its own, and stands (`lost: true`) for a lost box. The supervisor hands every order `RECORD_STARTED` (the recording's clock) and `RECORD_GEN`; the child's recorder syncs its spool, rolls it into 1 MB segments, and redacts its own machine's host name and boot id with no sign-in file.
