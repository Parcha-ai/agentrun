---
packages: @parcha/agentrun-serve
kind: feature
---
An agent whose notes no longer fit the learning budget (8 KB by default) now gives each run the notes that bear on it, not the newest. Each note is scored against the run's first message by a lexical match (BM25 over its name, description and body; a code review's changed paths, from a diff or a file list, count twice; no model call), and the run reads the best ones whole while they fit, then one line (`- <name> (<file>): <description>`) for each of the rest in place of the index. A run whose message shares no word with any note, and every agent whose notes fit the budget, reads exactly what it read before.
- The choice is one port, `NoteSelector` (`learning.ts`): `byRelevance` is the default and `byRecency` the old rule. The run's `# Learned` section and the notes it is given come from one choice, and nothing else about seeding, pinning or the cut of secrets changes.
- Upgrading: nothing to change.
