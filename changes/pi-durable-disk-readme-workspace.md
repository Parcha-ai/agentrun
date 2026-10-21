---
packages: @parcha/pi-durable-disk
kind: docs
---
The README opens with the agent as the workspace, and the package description is its short form: its conversation and its files live together in
one directory on a disk, which any Linux host or container can mount, release and mount somewhere else, and the agent carries on
where the last host released it. The second paragraph says what opening and releasing a run do on an Archil disk (mount and
claim, then seal, give up the claim and unmount) and on a plain directory (no mount).
