---
packages: @parcha/agentrun-serve
kind: fix
---
A reimport of a template package that raced its own delete (`POST /v2/templates/import` beside `DELETE /v2/templates/{id}`, the import answered `201` and the delete `204`) could leave the server serving a package the store no longer kept: every read of it was `404`, and every import of its name, the workspace's own included, was `409 name_taken` until a restart. The reimport's row could land before the delete read the row, and its package after the delete took the served copy away. A server now handles one package name at a time: an import keeps its row and serves its package, and a delete reads, removes and takes it away, each whole, so the two land one after the other and the server serves exactly what the store keeps.
