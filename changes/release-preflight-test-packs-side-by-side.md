---
packages: repo
kind: ci
---
`scripts/release-preflight.test.mjs` packs its fixture packages side by side, at most one per CPU, instead of one after another: 18 `npm pack` runs, 13 times in the file, which took most of its 257 s on CI and held up the test shard it sat on. On the shared box the file went from 330 s to 220 s; the receipt it writes is unchanged, in the release map's order.
