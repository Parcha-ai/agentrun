---
packages: @parcha/pi-durable-agent
kind: fix
---
A workflow revision can run inside a `pi-durable-disk run` process. `runWorkflowRevision` reads the run's store file once the workflow ends, and such a process holds that file exclusively until it exits, so the read failed (`disk I/O error`) after the workflow had run. Its two halves are now exports: `startWorkflowRevision(options)` checks the tools and the input, starts the run's task and waits for its outcome without reading the file, and `workflowCarry(run, outcome)` reads the run and returns the `carryBack` input, `{ state, summary }`. Inside a disk run, call `startWorkflowRevision` in the app and `workflowCarry` on the host once the run is released and its process has exited. `runWorkflowRevision` is the two in order, and returns what it did.
