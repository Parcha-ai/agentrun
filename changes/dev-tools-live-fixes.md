---
packages: @parcha/agentrun-serve
kind: fix
---
Three things the console's Dev tools said wrongly of real runs. A recording's step that was clicked is now the step marked and the one "Open this step in Dev tools" opens (of two steps at the same millisecond, still the later): Chrome reads a video sent to 4.023 s as 4.022999 s, and the step before was taken for it. "Show on the recording" lands on the call's own step for the same reason. The compare page says a run's cost as "at least" what is priced where one of its charges has no price, as the run's own tab says its cost so far, where it said the cost was not known. A run whose model was told to wrap up for its spend cap with no tool call refused reads "The run was told to wrap up for its budget", in the plain colour, and no longer in red that it stopped short near its cap: such a run may have done all it was asked, well under the cap. A run with refused calls still reads, in red, that it stopped short.
