---
packages: repo
kind: fix
---
The vision agent example reads the report page its answer names only from under `work/report/`. A path that leaves `report/`, by its parts or through a link (`report/` itself, a folder in it, or the page), gives the record it gives for a missing page, with a note on the answer's row that says why, and nothing it names is read or kept. A file in `report/` that is a link is not kept with the report. The Answer schema refuses a report path with a `.` or `..` part.
