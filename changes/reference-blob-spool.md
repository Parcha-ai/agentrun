---
packages: repo
kind: fix
---
The reference recorder writes each blob to a temporary file in the recording's `.spool/`, fsyncs it and renames it into `blobs/` whole, so a process killed while it writes (the budget stop, a planned kill) leaves a temporary file in `.spool/` and never a torn blob under a name that says it is whole. The validator and the gallery gate are unchanged: `.spool/` is never published.
