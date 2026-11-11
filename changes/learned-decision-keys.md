---
packages: @parcha/agentrun-serve
kind: feature
---
An agent's learned workflow can ask its typed questions on the runner: when a run's claim lays its learned workflows, it opens the decision keys of the providers those workflows name (Jev for a node that names none, Parallel, OpenRouter), from the server's environment first and then its saved keys, as it opens the run's own. They go to the run's tools alone, never to its model or a CLI harness's own environment, and are cut from its record like every key the claim opens. A provider the run's tool gate denies gets no key; a run with no learned workflow gets none, as before; and each claim reads its own, so no run holds another's.
Upgrading: nothing to do. A learned workflow's decision node that failed with "names the decision provider jev, which this host does not have" runs once the server holds that provider's key.
