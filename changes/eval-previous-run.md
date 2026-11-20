---
packages: @parcha/agentrun-serve
kind: feature
---
A template eval case can name `previous: fixtures/previous.json`, the earlier completed results of the package's schedule trigger, each checked against its own `output_schema` (else the package's) when the case is read; the eval writes them in its own server's store as completed runs of the run's agent, each started by a firing of that trigger, then fires the trigger on its clock, so the run is handed its last result whole, as its `x-carried` fields with the first entries dropped and counted, or nothing, said so, exactly as a scheduled run is. What the run was handed is on its report as `handed_previous`, and a new `handed` grader checks it (`expect: whole | carried | too_large | none`, with `dropped` counts for carried arrays).
