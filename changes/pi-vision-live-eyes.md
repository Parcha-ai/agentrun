---
packages: @parcha/pi-vision
kind: ci
---
A live eyes check, `node packages/pi-vision/test/live/eyes.mjs`, runs the built package as a host composes it (`read` and `fit` from `./durable`, eyes from `./eyes/pi-ai`) against a real model: a scanned letter whose identifier the eyes must read exactly, page 2 of a two-page PDF read with `page`, and the receipts (each paid look priced with tokens, a miss with no eyes at $0). It runs on a maintainer's machine with a key, never in `npm test` or CI. `PI_VISION_LIVE_EYES` names the model as pi-ai's catalog does, the key is the variable pi-ai reads for the provider, and `PI_VISION_LIVE_BASE_URL` points it at a gateway. Its last line is `ok: pi-vision live eyes passed` or `not ok: <step>: <reason>`.
- `npm test` and `npm run test:binaries` take `--concurrency N` (after `--`) or `TEST_CONCURRENCY=N` to cap how many test files run at once; the flag wins, a value that is not a positive integer exits 2 with the reason, and unset keeps Node's default.
