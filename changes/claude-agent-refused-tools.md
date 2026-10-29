---
packages: @parcha/agentrun-claude-agent
kind: feature
---
A call the CLI turns down itself (a tool the session doesn't have, a built-in that is off) reaches the host as a failed call by its name, with the model's input, and the adapter logs it once with the CLI's reason. The host hears it only once the CLI's answer is in the session's store, as a tool's `tool_end` waits for its outcome. An answer that does not reach the store within `barrierMs` leaves the call unshown, and the adapter logs `a refused call is not shown`. A call the session's tool server ran is never taken for one the CLI turned down, whatever its error text, so it is heard once.
