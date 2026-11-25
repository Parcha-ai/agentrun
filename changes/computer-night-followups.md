---
packages: @parcha/agentrun-serve
kind: fix
---
A run's browser rows and the janitor's Archil pass hold to the claim and say what they skip.
- A run's process removes its browser take or ended-wait row only when no later claim of the run wrote it, and only while the row is the one it read. Before, the remove checked only the key, so a claim still closing could clear the row of the claim that holds the run now, and the Screen tab read no take.
- The computer janitor logs `the computer janitor removed no mount credential of run <id>: …` when it ends a kept Archil computer whose row names no disk, saying the credential lapses at its ttl. Before, it ended the row without a word.
