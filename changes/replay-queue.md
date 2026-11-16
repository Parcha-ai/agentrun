---
packages: @parcha/agentrun-serve
kind: breaking
---
Learning: a running replay finishes. A learned workflow's revision that arrives while another revision replays no longer cancels that replay: it is queued (promotion record `decided: "queued"`), and replays at the first run's claim once the running replay is decided, whose verdict (promote or hold) stands. Only the newest queued revision replays next: one queued before it is `decided: "skipped"`, with `skipped_by` naming the newer revision and a reason that says so. The queue is the promotion records in the store, so a restart keeps it. Upgrading: `decided: "superseded"` and `superseded_by` are gone from the promotion records, and from a replay read's `decided`; read `queued`, `skipped` and `skipped_by` instead.
