---
packages: @parcha/agentrun-kernel
kind: ci
---
The kernel's spend cap, still unused until the cutover, counts a request that has no answer (its claim lost before the answer was written, or its turn cut) at its hold plus its bound, the worst it can have cost, and the run's cost then reads unknown with the known part beside it. Before, such a request counted at its hold alone, so a request that missed the cache could pass the cap unseen. `runner.request` keeps the bound the host gave beside the hold; a host that gives none is unchanged.
