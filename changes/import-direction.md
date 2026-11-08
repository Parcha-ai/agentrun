---
packages: repo
kind: ci
---
Imports follow the layer direction. `npm run check:direction` (`scripts/check-direction.mjs`, run in CI's checks shard) gives each workspace package one layer: protocol, kernel, plug-in, subsystem, server or surface. A protocol reaches nothing, the kernel reaches protocols, a plug-in reaches protocols and the kernel, a subsystem also reaches other subsystems, the server reaches anything and a surface reaches no workspace package. An edge is a manifest dependency, an import, export, `import()`, `require` or `import.meta.resolve` of a workspace package, a relative path into another package, or a surface naming one of the server's data files. Today's 23 wrong edges are listed as exceptions, each with its count, reason and fix. A new wrong edge fails, and so does an exception that no longer occurs, so the list shrinks as the fixes land.
