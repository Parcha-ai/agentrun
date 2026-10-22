---
packages: @parcha/agentrun-dsl
kind: fix
---
Validation refuses a declared write to any state key that holds a `$`, not only one that starts with it. A typed question's sidecars, `<as>$answers` and `<as>$verify`, were documented as engine-owned, yet a node could write `gate$answers` by `as`, by an unaliased label, or by a collecting map's `failedAs`, and overwrite the answers a code gate reads. The label message now reads `label must not contain "$"`, and the author contract says keys that hold a `$` are engine-owned. Reading a sidecar is unchanged. A code node's patch may still write a `$` key at run time, as the Lean model documents (finding F3).
