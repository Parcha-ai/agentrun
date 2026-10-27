---
packages: repo
kind: ci
---
**pi-durable-disk's live-prepare test no longer fails when another test changes the package directory**
- The Daytona live helper packed the package by having tar walk its directory. Other tests write there while the suite runs (package.test.ts creates `.tmp/`), and tar fails a directory whose entries change while it reads them ("file changed as we read it"). The helper now packs a list instead: the files git tracks or would track, plus the built `dist/`. That is the same set of files as before, and a test packs it while another process churns an entry in the directory.
