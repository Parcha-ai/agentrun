---
packages: @parcha/agentrun-serve, @parcha/agentrun-computer
kind: fix
---
A synced folder keeps its links and modes when the run moves off an Archil mount, and a runner that lost its claim can no longer write the run's folder.
- A run whose folder was on an Archil mount and whose next claim syncs it (Daytona's `DAYTONA_ARCHIL_EGRESS` removed, or a provider moved to connect `dial`) now finds its links and modes there. Before, the claim failed on a link an exec made (`read "go": 501`), and every file came back at 0644. An Archil computer's park and release record the folder's modes and links in `runs/<run>/sync.json` (read through computerd, which sees the mount), and the synced claim pushes them, then removes the exec-made link objects from the disk.
- Every write a claim makes to the run's folder on the disk (each put, mkdir, remove and sync.json write) first reads the run's claim from the store, and is refused, never sent, once another claim holds the run: "this runner no longer holds the run's claim, so its write to the run's folder was not sent". Before, a runner whose run was claimed by another went on writing the folder.
- `FolderSync.recordMeta()` writes a folder's modes and links, as the computer lists them, to its sink, and nothing else.
