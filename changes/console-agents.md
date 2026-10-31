---
packages: repo
kind: feature
---
The console's agents: the list (and the archived ones) and an editor for a new agent or the next revision of one. The editor has context, tools and skills, settings (the harness from the server's `harnesses`, a harness it does not run shown disabled with its reason; thinking; model) and history (make an earlier revision current), plus archive and unarchive. A save is made on the revision the editor loaded (`If-Match`). When another save landed first, the editor says so and keeps nothing over it. A 422 shows its fields where they are. An edit keeps every definition field the form does not show, and the name and description the agent was created with.
