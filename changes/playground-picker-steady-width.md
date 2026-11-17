---
packages: @parcha/agentrun-serve
kind: fix
---
The API playground's operation picker keeps one width. The field was as wide as the operation picked, so it grew and shrank with each choice, and its list, as wide as the field, wrapped "POST · Apply a template" onto two lines. The field is now as wide as its longest operation needs on one line, and the list is never narrower than its longest row. The console's `Picker` takes this as `steady`; every other picker is unchanged.
