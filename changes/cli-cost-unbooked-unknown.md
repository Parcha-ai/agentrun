---
packages: @parcha/agentrun-serve
kind: fix
---
A Claude Code, Codex or OpenCode run whose model answered or called a tool, but whose model requests reached no booking (they went past the run's model proxy), now reads its cost as unknown: on its row, its view, the runs list, its spend as the cap reads it and the /usage tokens meter. It used to read $0, the sum of no bookings.
