---
packages: @parcha/agentrun-serve
kind: fix
---
An edit sent without `If-Match` that another edit overtakes while it is being checked is built and checked again on the new current revision. What it leaves out (skill files, harness, place) now comes from the revision it is committed on, never from the one it first read, so it cannot undo the other edit.
