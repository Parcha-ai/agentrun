---
packages: @parcha/agentrun-kernel, @parcha/agentrun-serve
kind: fix
---
A run's spend-cap pause no longer says it spent "$0" when it spent less than a cent. The words round what was spent to the cent, so a run that had spent $0.003 read "this run has spent $0 of its $0.105 cap", as if nothing had been spent. A spend above $0 that rounds to $0 now reads "less than a cent" ("this run has spent less than a cent of its $0.105 cap"). A spend of exactly $0, and any spend of a cent or more, reads as before. The exact amount stays in the pause's `spent_usd`.
