---
packages: @parcha/agentrun-computer
kind: fix
---
Morph's box build no longer times out on its own base snapshot: `POST /snapshot` answers only once the snapshot is made (78 s measured), so it now has the build's remaining time instead of 60 s. A build looks for a base by its label (`agentrun-box-build=<name>`) before it makes one, and again after a create whose answer is lost: a ready base is used, a pending one waited for, a failed one deleted, so a lost create no longer leaves a base snapshot that nothing deletes.
