---
packages: repo
kind: feature
---
The reference example is now a platform for demos: `demo({ self, spec, job, fakes })` reads the standard flags (`--live`, `--kill`, `--record`, `--input`, `--max-usd`, `--local-chrome`, `--dir`, `--json`) and runs a spec's `kills` through a supervisor. A kill is a named crossing, a storm, or a box kill (`kind: "box"`), and may target a tool's box (`target: "tool"`) instead of the run's process. The spend cap is metered on the recording and stops a run past it. A live run drives Browserbase when its key is set, and a local Chrome only when asked for. The entry hands a demo a box provider with `transport.box.*` crossings and transport box lines built in; the crossings are listed in `examples/reference/README.md`.
