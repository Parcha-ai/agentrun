---
packages: @parcha/agentrun
kind: ci
---
The CLI tests no longer read a cut-short `server openapi` answer. The OpenAPI document grew past `spawnSync`'s 1 MiB output buffer, so the test killed the CLI part way through and sometimes parsed half a document. The tests now give the CLI room for the whole document, and a spawn that fails (a timeout or a full buffer) fails the test with its cause. The CLI itself always wrote the whole document.
