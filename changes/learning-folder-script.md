---
packages: @parcha/agentrun-serve
kind: breaking
---
The agent's learning folder is written by one checked-in POSIX sh script (`learn/learning.sh`), run through the folder's Workspace as one exec per write. The script commits by compare and swap on main (a lost race exits 3 and writes nothing), brings the working tree in line, writes a merge's `.agentrun/diffs/<run>.json`, and writes `.agentrun/snapshot.json` last (snapshot v1). That covers a run's merge, a person's edit, create, retire, approve and restore, and the folder's first commit. The learning routes read only the snapshot, the bodies it names (each checked against its blob id, one retry, then 503) and the diff files, through the Workspace file API. They run no git and exec nothing, and every response keeps its shape. A later page's cursor reads at its main while the server still holds that snapshot, and otherwise answers as the first page of main now. A top-level `.md` that is no note (no front matter) is no longer served: it reads 404, and a retire by its blob gets 412.

Upgrading: a learning folder made before this has no `.agentrun/snapshot.json`, so it reads as empty until its agent's next run starts. That start rebuilds the snapshot from main.
