---
packages: repo
kind: docs
---
The run cap queues follow-ups as it queues new starts: a follow-up to a finished run is accepted (202) and waits for a free place, never refused with a 429, and a message to a run that already holds a place takes no second one. Two tests, once skipped for a refusal this server never made, now hold that with concurrent starts: at most the run cap's worth of runs are claimed at any time.
