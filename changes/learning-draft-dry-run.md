---
packages: @parcha/agentrun-serve
kind: feature
---
A workflow draft a run proposes is dry-run before it is kept: the workflow DSL runs it on the run's own input (its block's new `example:` front-matter line, else an input made from its schema) with every model and tool answer synthesized, so no request is sent, nothing is paid and no tool runs. Only a draft every static check passes is dry-run, and no code in it runs in the host: a code node is refused before the dry run, and the dry run hands any code node to a runner that refuses it. A draft whose wiring breaks at run time (an output path no step produces, a step's output that fails its schema), which validation alone passed, is left out alone, and the end-of-run turn is asked once more to fix it; a draft that passes is proposed with its dry run, and the grader is told it. The example is the run's input, so it is never written to the learning folder, and one holding a secret refuses the answer as any text does.
Upgrading: nothing to do; a run's proposal may now carry `dryRuns` beside its files.
