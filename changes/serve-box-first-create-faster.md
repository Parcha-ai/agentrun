---
packages: @parcha/agentrun-serve
kind: fix
---
A sandbox run's first box is made sooner, and archiving a run answers before its box is gone.
- A new run makes its first box without looking for one first: no `docker ps` by its label and no inspect before the create. The server that starts a sandbox run writes `box-none` in its directory, and the run removes it before that create. A process of the run that starts again finds no such file and looks by the label, so a relaunch still takes over the box its earlier process made, and so does any run a server before this version started.
- `POST /v2/runs/{id}/archive` (and an agent's archive) answers once the archive is saved. The run's box is destroyed after it, on the run's settle chain, which a later settle and the server's close wait for, and an unarchive waits for it too, so no new work starts in a box being removed. It used to answer only once Docker had removed the box, about 1.7 s for a run that waited.
