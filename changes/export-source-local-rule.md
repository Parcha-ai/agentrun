---
packages: repo
kind: fix
---
`npm run export:source` leaves out only a machine's own `*.local.*` and `*.local` files, as its receipt says. Its rule also dropped any path component named `local` or starting with `local.`, so the source archive was missing `packages/pi-transport/src/box/local.ts`, the file behind pi-transport's `./box/local` export. The reference host imports that file, so the downloaded source did not build (`verify:source`). Across the tracked tree, it is the only file the archive gains.
