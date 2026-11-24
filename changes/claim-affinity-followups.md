---
packages: @parcha/agentrun-serve
kind: fix
---
A stopped or cancelled run's kept desktop, phone or sandbox is now deleted when the run ends, by whichever runner ends it, instead of staying up until its 10 minutes pass. When the runner that kept a machine refuses new runs, the run resumes on another runner with a new machine, the timeline says the runner that kept the old one ends it, and that runner does. The timeline says a park kept its machine only once the keep is saved, GET /v2/runs/{run_id}/computer says a machine whose keep ended early wasn't kept, and the 10 minutes run on the store's clock, so a runner whose clock is off no longer moves them.
