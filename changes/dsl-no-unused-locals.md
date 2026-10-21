---
packages: @parcha/agentrun-dsl
kind: ci
---
The DSL package's build and type-check reject an unused local, import or parameter (`noUnusedLocals`, `noUnusedParameters`), and the two unused imports they found in the recovery handoff block are gone. The emitted JavaScript and declarations are byte for byte what they were.
