---
packages: @parcha/agentrun-serve
kind: fix
---
A sandbox run's first box is made sooner, and archiving a run answers before its box is gone.
- A run that never made a box makes its first one without looking for one first: no `docker ps` by its label and no inspect before the create. A mark in the run's directory (`box-made`), written before the create, tells a process of the run that starts again to look, so a relaunch still takes over the box its earlier process made.
- `POST /v2/runs/{id}/archive` (and an agent's archive) answers once the archive is saved. The run's box is destroyed after it, on the run's settle chain, which a later settle and the server's close wait for. It used to answer only once Docker had removed the box, about 1.7 s for a run that waited.
