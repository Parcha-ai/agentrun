---
packages: @parcha/agentrun
kind: feature
---
`agentrun race start ... --wait` and `agentrun race show LABEL --wait` follow every lane's run to its end, on the run's own timeline as `runs wait` does, then print the lanes side by side: lane, harness and model, status, cost of cap, seconds, and the first line of each answer (control characters removed). `--json` prints the lanes as JSON instead. Exit 0 when every lane completed; 1 when a lane failed, was cancelled, did not start or still runs past `--timeout` (default 1800 seconds, the runs go on), each such lane named on stderr; 8 when no lane failed but one waits on a person, with where to answer it (an approval on the race's page in the console).
