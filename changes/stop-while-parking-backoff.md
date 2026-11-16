---
packages: @parcha/agentrun-serve
kind: fix
---
A stop that reaches a run while it parks on a tool approval, and whose end the journal refuses, now waits out its retry backoff. The run was released still parked, and a parked run with an untaken stop is claimed at once whatever its backoff, so the end was tried a second time with no wait and the give-up came one try early. The refused end now releases the run running, as every other refused end does: the next claim comes after the backoff, and the tries count one per step (5 s doubling to the 5 min cap).
