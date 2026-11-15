---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel
kind: fix
---
A sandbox run resumed after a server stop, and any run resumed after a park, is now told its computer is new. Before, only a desktop or a phone was told after a server stop, and a parked run's resume never was. The ready line says "It's a new <kind>: the one before is gone, with what was on it." The model's note names no cause, and it reads by kind: a desktop or phone is told to look at the screen again, and a sandbox to check its files. The note and the cap's wrap-up note now start with "AgentRun server note:". The timeline row still reads "AgentRun: …" with the label only once. The run's journal now records each computer a claim makes, and a later claim reads that record. A run that made its computer before this upgrade has no record, so if it resumes after the upgrade on a new computer, it isn't told.
