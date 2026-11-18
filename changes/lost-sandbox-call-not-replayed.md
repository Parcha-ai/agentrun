---
packages: @parcha/agentrun-serve
kind: fix
---
A command running when its sandbox is lost is no longer run a second time on the new sandbox. Before, a bash call cut by a hosted provider's delete (Daytona's `not_found` "was deleted" words) was read as "bash is not there", re-sent as `sh -c` and routed to the replacement sandbox. It then ran from the start and ended `success`, with nothing in the tool result saying so. Now the call in flight when the loss is confirmed, and any call alongside it, fails with code `gone`: `the computer <name> was lost while this call ran, and it was not run again: <the provider's words>. A new computer starts at the next call.` The next tool call starts the new sandbox as before. The bound of 2 new sandboxes a claim and the `computer_unavailable` end past it are unchanged.
