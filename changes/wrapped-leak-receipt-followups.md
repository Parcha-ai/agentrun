---
packages: @parcha/agentrun-serve
kind: fix
---
The leak receipt's count holds in more cases. An import stops a run's key tally however the run ends, so a run that throws no longer leaves its tally counting the keys of every later run. `GET /v2/wrapped` adds up only imported runs: a live run's `secrets` metric, or a count that is not a whole number of zero or more, is in no figure. In the console, the receipt is asked for again when the year changes, and its footnote reads "From the N runs counted on import; counts only, no key shown."
