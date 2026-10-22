---
packages: repo
kind: docs
---
The recovery models state the host's cancel. `spec/receipts/Receipts.tla` adds a stop whose commit may fail and the host letting go of the driver with `close`, with three properties: a stop the host let go of is on the journal or the host heard that it is not (`I8_StopOnJournalOrHeard`), nothing is admitted or dispatched after a stop (`I9_NoAdmissionAfterStop`), and a cancelled run never resumes (`I10_CancelledNeverResumes`), each with a guard mutant TLC must catch. `spec/lean/AgentRunRecovery/Frozen.lean` proves the same for every number of steps and crashes (`stop_admits_nothing`, `stop_dispatches_nothing`, `cancelled_never_resumes`), with a witness that a refused stop commit is reached and heard.
