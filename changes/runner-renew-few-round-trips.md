---
packages: @parcha/agentrun-serve
kind: fix
---
A runner's renew of the claims it holds, and its claim of a batch of runs, are each a few statements on the store whatever the count, never one or two a run. On Postgres a runner holding 300 runs renewed them in about 600 round trips with every row held, so a database a few milliseconds away (a loaded host) stretched the renew past the runner's claim deadline: every claim was lost at once, and the runs were claimed again and started over, again and again.
