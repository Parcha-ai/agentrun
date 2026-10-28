---
packages: @parcha/agentrun-pi
kind: fix
---
A record's scalar repair reads a field's `$ref` through the root schema's `$defs` as well as its `definitions`, at the top and in nested objects, so a string the referenced schema lists (a `const: "null"`) is kept as the value, never turned into JSON null. `parseStringifiedContainers`'s fourth argument is now the root schema (it was the root's `definitions`).
