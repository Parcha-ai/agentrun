---
packages: repo
kind: fix
---
A repository script, example or test fixture run as a command on a Node without `import.meta.main` (20, 23, 24.0 to 24.1) now exits 1 with one line naming the file, the Node it ran on and the Node the repository needs. Before, each one exited 0 having done nothing, so `node scripts/changes.mjs --check` on Node 20 passed without checking anything. They decide they are the command with `isMain(import.meta)` from `scripts/is-main.mjs`, which is `import.meta.main` where Node sets it; where Node does not, it compares the realpaths of `process.argv[1]` and the module, refuses the command, and leaves an imported module alone. `scripts/entry-points.test.mjs` fails on any script that reads `import.meta.main` itself. `apps/viewer/build.mjs` stays as it is: it deploys from `apps/viewer` alone, and on Node 20 its TypeScript imports already fail.
