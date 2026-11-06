---
packages: repo
kind: fix
---
The console's agent pickers (Playground's Agent, Mission Control's Agent, a schedule's Agent) list agents by name, A to Z, ignoring case and accents, a number in a name read as a number ("agent 9" before "agent 10"), the id breaking a tie. Before, Playground listed them newest first, which is hard to scan with many agents. All three use one order (`byName` in `lib/agents.ts`).
