---
packages: @parcha/pi-durable-disk
kind: docs
---
**Examples say which published version they need, and how to run one from an install**
- `examples/README.md` gains a "Since" column (the first published version that has what each example imports) and a
  "Run one from an install" section: an empty directory, `npm init -y && npm pkg set type=module`, the README's install
  line, the example's files, `node main.ts`. `fork-into-many` and `planned-move` need 0.1.0-beta.14 or later (`forkLocal`,
  `archilControl` and `beforeResume`'s `previous` are not in 0.1.0-beta.13, where they stop at their import); each example's
  README states its version. Checked by running each keyless example against the published 0.1.0-beta.13.
