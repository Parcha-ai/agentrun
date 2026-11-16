---
packages: @parcha/agentrun-computer
kind: docs
---
`packages/computer/SCORECARD.md` is re-scored against main as of `3705f7eadf`: its links to the host members point at "The eleven members", and its rows follow the trimmed contract and the shared pieces that landed since it was written. DigitalOcean is blocked (its auto-pause can't be switched off); Hyperbrowser and Render are blocked (`labels: "machine"` needs each machine's image, and their sandbox records carry none); Together fits if its unverified facts hold (`sse` reads its output). The counts are 0 clean, 5 fit if, 13 need a workaround, 10 blocked.
- `scripts/check-doc-anchors.mjs`, run in CI through its test with the other scripts tests, reads each tracked Markdown file with marked's lexer (the console's `marked`, now a root dev dependency at the same version) and fails on a relative link whose path is no tracked file or directory, or whose `#fragment` no heading (by GitHub's slug rule) or `<a id>` anchor in the target makes.
