---
packages: repo
kind: feature
---
`models.judge.caps` in demo.json (`{ requests, tokens }`, each a positive integer at most 4 times the default of 50 and 40,000) sets the demo's own Jev caps; a value past the ceiling is refused at load, the run still refuses past the caps and `--max-usd` still applies. A demo that names `models.judge` (Jev) without a `keys` group for `TYPESAFE_API_KEY` or `OPENROUTER_API_KEY` is refused at load, naming the group to add.
