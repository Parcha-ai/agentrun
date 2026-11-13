---
packages: @parcha/agentrun-serve
kind: fix
---
Serve's last file-era durable readers are gone: `workflow/readers.ts` (`durableDoc`, `readJournal`, `withDurableFile`) and the WAL commit check only it used (`workflow/wal.ts`). Nothing in a source file imported them and none was in the package's public entry point; the tests that held the document store to what it writes now read the file through a small helper of their own.
