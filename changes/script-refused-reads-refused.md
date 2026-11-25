---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel
kind: fix
---
A `codemode` script that stops at a call the run refused (a tool set to deny, a person's deny) now reads Refused on the run's Timeline, as the refused call inside it does. Before, the script's own row read as a call that ran and failed, so the console showed a red Error chip on it and a neutral Refused chip on every other refused step. The same holds for `tools_call` of a refused tool. A host tool that `nests` may now answer `refused: true` with its error; pi marks that result refused, and the other harnesses end the call refused. The console's Refused chip on a script says it stopped at a refused call, its calls before that one having run. The script's text, and what the model reads, are unchanged.
