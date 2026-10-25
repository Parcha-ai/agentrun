---
packages: repo
kind: fix
---
**A script run through a symlinked path now runs as the command**
- `apps/viewer/build.mjs` and 28 other repository scripts and examples decided they were the command by comparing `process.argv[1]` with their own URL. Node resolves a module's URL through symlinks and leaves `argv[1]` as given, so through a symlinked directory (macOS's temp directory is one) each one exited 0 having done nothing: a site build on a Mac built no viewer. They now check `import.meta.main`, which Node sets from 22.19. `scripts/entry-points.test.mjs` fails on any script that compares the two again.
