---
packages: @parcha/agentrun-dsl
kind: docs
---
The README has a "Durable runs" section (`openRecovery`, `fileStore`, `withRecovery`: a run opened again with the same key answers committed steps from the journal and runs the rest), with a sample that dies and resumes with no key, and an "A judge on any model" sample whose `runJudge` is a plain function. It no longer says that hosts own recovery: the host chooses the store and the package ships the driver.
