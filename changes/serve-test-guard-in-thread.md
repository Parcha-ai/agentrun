---
packages: @parcha/agentrun-serve
kind: ci
---
The serve suite's SQLite guard now installs its resolve hook in-thread (`module.registerHooks`) instead of on a loader thread (`module.register`). Each test process loads the package about twice as fast (importing `dist/index.js`: 3.6 s to 1.6 s), the suite spends about a quarter less CPU, and a test's `require("node:sqlite")` now gets the guarded class too, as its `import` already did.
