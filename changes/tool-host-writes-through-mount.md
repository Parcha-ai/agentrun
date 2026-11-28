---
packages: @parcha/agentrun-serve
kind: fix
---
In a run whose folder is on an Archil disk and whose computer mounts it (a sandbox, or a desktop that mounts the folder), every `web_save` failed after about 60 s with `UNAVAILABLE: the backend cannot answer: the root is gone, the disk is full or read-only, an I/O error`, and nothing was saved. The same happened to a monid answer too long for the model, which is filed in the run's files. Both wrote over the disk's file API, which the service refuses while the computer's mount holds the folder, and the write gave up once its 60 s wait for the hold ran out. They now write through the computer, as the run's own file tools and its MCP's files already do. A run with no computer that mounts its folder is unchanged.
