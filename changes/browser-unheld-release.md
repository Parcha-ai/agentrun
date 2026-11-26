---
packages: @parcha/agentrun-computer, @parcha/agentrun-serve
kind: fix
---
When serve lets a run's claim go (the run ends, is stopped, or parks), it now releases every cloud browser that carries the run's labels and the claim's epoch and that nothing the run holds names: not a session's browser by id, and not a browser whose session tag a held, not yet created session still owns. Before, a browser one create of a request made and then lost (its reply lost, its recovery keeping it because an older browser was answered) ran unheld until the vendor ended it, up to 6 hours on Browserbase and about 72 hours on Kernel: the janitor refuses vendor-lifetime providers, and a later claim's sweep releases only lower epochs. A browser another run made, or a later epoch's, is never touched.

Each browser released this way is charged on the run from the time its vendor listing says it was made, through the same booking every other browser charge takes, and the run's timeline says so: `AgentRun: Released 1 browser this run no longer held (<id>); its time is in the run's cost.` A browser the release could not end is named too, as running to its vendor's lifetime.

`@parcha/agentrun-computer` adds `releaseUnheld(provider, run, epoch, held)`, which lists the run's computers and releases each of that epoch the `held` predicate refuses, and `ComputerInfo.createdAt`, which the Browserbase and Kernel listings now fill.
