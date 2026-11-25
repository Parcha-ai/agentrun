---
packages: @parcha/agentrun-serve
kind: fix
---
`template eval` no longer cancels a run whose runner's claim lapsed for a moment. On a stalled machine a claim can go unrenewed and be taken again moments later. Before, the eval read the claim once per window, so a read in that gap cancelled a run that was being worked on, saying "no runner holding it". Now, once a runner has held the run, the eval reads its claim on every queued page, at most once every 5 s. It cancels only when every read across a whole queue bound found no runner holding the run.

The queue bound goes from 2 minutes to 5 minutes, because a busy machine's runner can be slow to make its first claim. The cost: a run that no runner ever takes now waits 5 minutes before the eval cancels it, not 2. The same bound applies to a feed, email or schedule case whose trigger starts no run.
