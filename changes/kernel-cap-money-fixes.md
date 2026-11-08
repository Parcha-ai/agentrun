---
packages: @parcha/agentrun-kernel
kind: ci
---
The kernel's spend cap, still unused until the cutover, refuses to admit a step id again while its last end mark is unwritten, so a retried settle can't book the new step at the old step's figure. It reads a host hook's spend or hold that isn't a finite figure of 0 or more as unknown and refuses the request, and never counts it as $0 or as room. It won't price a request in flight at 0 output when it has no hold, no output limit and no ceiling.
