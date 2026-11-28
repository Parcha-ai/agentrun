---
packages: @parcha/agentrun-serve
kind: fix
---
A share host reads every workflow call's output with that call's command, whatever its index in the graph. Before, an output past the millionth effect was read with no context, so a plain `.pgpass` line printed by `cat ~/.pgpass` was taken. A graph with more effects than an export can write (72,944 in 8 MiB) is now refused with `400`. The scrubber keeps nothing between scrubs: a caller that reads one call's output string by string hands each scrub the command's facts, made once (`ScrubOptions.commandFacts`). Before, the last command read was kept in one module-level slot.
