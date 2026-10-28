---
packages: @parcha/agentrun-serve, @parcha/pi-durable-agent
kind: fix
---
A pi run's model request is counted when it leaves, not when its answer starts. serve marks each generation request on the run's root (`agentrun.request_started`, `REQUEST_STARTED` from `@parcha/pi-durable-agent/timeline`) before sending it, and the timeline counts a request it has a mark for and no `pi.assistant` entry (cut before its first content, by a stop or a crash) at an unknown cost: the run's usage reads unknown with every request counted, never the sum of the others. A request the cap refuses is never sent and never marked; pi's compaction is not marked.
