---
packages: @parcha/agentrun-serve
kind: fix
---
The Free page no longer lists a template that can cost money through a tool. A template that names a Monid endpoint (`monid:…`) is left out: its calls are booked on the server's Monid key. So is one that grants `subagent`, unless its package names both its `fast` and `strong` models and each is one of this server's free models. A tier the package leaves out runs on the host's model for it, which may bill.
- A template's Apply screen opened from a link whose `?model=` is not one of this server's free models now says so: its runs may cost money. "Use free" sends a free one.
- A model pull no longer stops while Ollama checks the download. After `verifying sha256 digest`, Ollama hashes the whole model with no further output, and on a slow disk that takes minutes. A pull now waits up to 15 minutes there, and two minutes everywhere else as before.
- The pull's long-line error now says characters, as it counts, not bytes.
- The usage read's `unheld_quantity` and a computer interval's `booked_seconds` now say both are 0 on a provider that bills nothing (Docker), and that `unheld_quantity` is null when `quantity` is only on a provider that bills.
