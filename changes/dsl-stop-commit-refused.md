---
packages: @parcha/agentrun-dsl, @parcha/agentrun-pi
kind: fix
---
A recovery driver whose pause or cancel commit the store refuses now says so: `flush()` throws the refused commit, and `close()` throws it after releasing the journal. Before, both resolved, the journal still read `running`, and the next open resumed a run the host had been told was cancelled. The run reports the stop (`FROZEN_CANCELLED` or `FROZEN_PAUSED`), or the refusal itself when the refusal reaches one of the run's own commit waits first; a host that awaits `close()` and sees it throw must not take the run as stopped, and can open it and stop it again. A run's own failed commit is unchanged: the run and `flush()` throw it, and `close()` does not throw it again. A durable pi run whose journal refuses a cancel taken when its next process starts hands its waiters that refusal, where they got a poisoned-Session error before; the task stays pending, and a later process takes the cancel.
