---
packages: repo
kind: fix
---
**A script run through a symlinked path now runs as the command**
- `apps/viewer/build.mjs` and 28 other repository scripts and examples decided they were the command by comparing `process.argv[1]` with their own URL. Node resolves a module's URL through symlinks and leaves `argv[1]` as given, so through a symlinked directory (macOS's temp directory is one) each one exited 0 having done nothing: a site build on a Mac built no viewer. They now check `import.meta.main`, which Node sets from 22.18 on 22 and from 24.2. `scripts/entry-points.test.mjs` fails on any script that compares the two again.
- Node 23 and Node 24.0 to 24.1 have no `import.meta.main`, so there these scripts would exit 0 having done nothing. `scripts/check-node.mjs`, which `npm run build` and the demos run first, now refuses them: the repository needs Node 22.19 or newer on 22, or 24.2 or newer.
