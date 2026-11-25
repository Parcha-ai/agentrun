---
packages: @parcha/agentrun-serve
kind: fix
---
A run's browser rows hold to the claim, and the janitor ends what a failed give-back or a refused credential remove left.
- A run's process removes its browser take or ended-wait row only when no later claim of the run wrote it, and only while the row is the one it read. Before, the remove checked only the key, so a claim still closing could clear the row of the claim that holds the run now, and the Screen tab read no take.
- The computer janitor logs `the computer janitor removed no mount credential of run <id>: …` when it ends a kept Archil computer whose row names no disk, saying the credential lapses at its ttl. Before, it ended the row without a word.
- A claim that could not reach a kept machine and could not write its row back now writes it under `computer_given_back:<run>:<id>`, and the janitor ends that machine as it ends a kept one. Before, the machine ran with no row until its provider's own end.
- A run's end that keeps no computer and whose Archil credential remove fails now leaves `archil_revoke:<run>`, and the janitor's next pass removes the credential, then the row. Before, it was only logged and the credential stood until its 24-hour ttl.
