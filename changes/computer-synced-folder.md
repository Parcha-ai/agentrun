---
packages: @parcha/agentrun-computer
kind: breaking
---
A computer can take a synced folder, `mount: { kind: "sync" }`: a plain `/workspace` owned by the computer's user, which the runner fills and reads back over the computer's own file and exec calls, with no FUSE. Every provider configuration with `files` and `exec` takes it (derived, never listed in a descriptor), Daytona's and Modal's GPU computers included; Docker keeps its bind, and Orgo takes none. `FolderSync` reads a folder's changes since the last sync into a `SyncSink`, and the root exports a streaming tar reader and writer (`tarOf`, `tarStream`, `untar`, `untarStream`, `TarReader`).
Breaking: `ARCHIL_MOUNT_LABEL` is `MOUNT_LABEL`; `RecordedArchil`, `recordedArchil` and `readArchilMount` are `RecordedFolder`, `recordedFolder` and `readMount`; and `syncingClient(client, sync)` takes the sync it runs, `archilSync(client)` for an Archil mount.
