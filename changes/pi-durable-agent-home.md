---
packages: @parcha/pi-durable-agent
kind: feature
---
New held package `@parcha/pi-durable-agent`: an agent you can carry, as one directory of pi-durable stores
(`agent.sqlite`, and `runs/<id>/run.sqlite` per run). `createAgentHome` and `openAgentHome` keep the agent's identity,
its definition (no model or thinking level: the host picks them), its skills, and each host's alias and tool bindings.
`startRun` seeds a run's store and workspace from the home and takes the save lease on each browser profile no live run
holds; `durableProfileStore` is pi-browser's `ProfileStore` over the run's `browser.profiles`; `carryBack` copies back
the profiles the run may save, releases its leases and completes its entry in the runs index, once per run. Writers
queue on the home's `owner.lock` and fail with `AgentHomeError` (`busy`) after 5 seconds.
