---
packages: repo
kind: fix
---
A script in `scripts/` run on a Node without `import.meta.main` (20, 23, 24.0 to 24.1) now exits 1 with one line naming the script, the Node it ran on and the Node the repository needs. Before, it exited 0 having done nothing, so `node scripts/changes.mjs --check` on Node 20 passed without checking anything. The scripts decide they are the command with `isMain(import.meta)` from `scripts/is-main.mjs`, which is `import.meta.main` where Node sets it; where Node does not, it compares the realpaths of `process.argv[1]` and the script, refuses the command, and leaves an imported module alone. `scripts/entry-points.test.mjs` fails on any other file that reads `import.meta.main` itself. The examples (copied into consumer and scratch projects), the package test fixtures (kept to their packages) and `apps/viewer/build.mjs` (deployed on its own) keep `import.meta.main`.
