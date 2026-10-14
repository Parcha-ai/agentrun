---
packages: repo
kind: feature
---
`npm run demo:kill -- --record <dir>` records the killed and resumed run as an `agentrun.recording/1` directory: each process records its own durable and live lines, and the supervisor, which outlives every kill, writes the `process.started`, `kill` and `result` lines.
