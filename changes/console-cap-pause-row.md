---
packages: repo
kind: fix
---
A run paused at its spend cap says why once, in its banner. On the timeline, the pause is the server's own row (a `phase` row with `paused: true`, "Paused at the run's cap"): it reads as any server row, AgentRun with the served words, muted, with a pause icon, where a red "Error" row repeated the banner's sentence. The same row stays after the cap is raised, and it never counts as a failure on the page. The run's waiting row says "Paused at cap" for a cap pause, as its status does, where it said "Input required". A request that failed at the cap is still an error, in red.
