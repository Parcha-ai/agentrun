---
packages: @parcha/agentrun-serve
kind: fix
---
The janitor's pass over left Archil credential removes is bounded as a whole, and a failed leave is logged and tried again.
- The pass over the `archil_revoke:<run>` rows now has one bound for the whole pass, the kept delete bound. Once it passes, the remove being asked is cut, and the rows not yet asked stay for the next pass, reported in one line. Before, each row had its own bound, so N hanging rows held the provider sweep and the next wake for N bounds.
- When a run's claim ends and the store refuses to write the left row, the runner now logs `run <id>'s Archil mount credential remove could not be left for the janitor, so it lapses at its ttl: …`, and a later leave writes the row. Before, the failure was dropped, and the rejected write was cached, so no later leave could write the row.
