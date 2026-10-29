---
packages: @parcha/pi-transport
kind: fix
---
A launcher process that one launch of a name started (its supervisor, watchdog or a run of its program) now holds that launch's generation, and never the generation the spec holds when it starts. Before, a supervisor the watchdog of an earlier launch started just after a later launch of the name had rewritten the spec took the later launch for its own, and could start the program again beside it. Now it sees it is the earlier launch's and leaves. The generation travels in the started process's environment only; the program never sees it.
