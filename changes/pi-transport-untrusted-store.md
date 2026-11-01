---
packages: @parcha/pi-transport
kind: fix
---
**A store a box made is opened on the host only read-only and defensive, and never written: no trigger, view or schema of its own, no extension**
- `verifyStore` opened a checkpoint's store, a file the box made, with SQLite's default settings, and `replayCommits` opened it to write through pi-durable, so a trigger in it ran on the host's commits. Now both read such a file one way only: a regular file of at most `DEFAULT_MAX_STORE_BYTES` (1 GiB, or `{ maxBytes }`), opened `immutable` and read-only, with `query_only` on, `trusted_schema` off, `cell_size_check` on and no extension loading; on Node 24 also defensive (`SQLITE_DBCONFIG_DEFENSIVE`), with `ATTACH` limited to none and an authorizer that lets only a select, a column read and the quick check through. Node 22's `node:sqlite` has none of those three.
- The schema must be the one pi-durable makes, object for object, before the quick check runs: a trigger, a view, a virtual table or a table of the file's own is refused with the new `StoreErrorCode` `refused`, as are a file over the limit, one that is not a regular file, and a store of another pi-durable schema version.
- `replayCommits` never opens the file to write: the rows of pi-durable's tables are read into a store pi-durable makes on the host, which takes the file's place, and the commits go into that one. A file it refuses is `failed` with nothing applied, and a restore then uses the checkpoint as it is. `verifyStore` and `replayCommits` take an optional `{ maxBytes }`.
