---
packages: @parcha/agentrun-computer-bench
kind: feature
---
`android-dev` gets 18 new tasks, nine dev and nine heldout, each verified on a cloud phone: the untouched state fails and the oracle's state passes on seeds 1-3. They cover Settings, Clock (timer, alarm repeat days, a new repeating labelled alarm), Contacts (favourites, delete, a labelled email, reading a work number, counting favourites), Files (a nested folder, deleting PDFs, the largest file) and two cross-app tasks. Each one sets `exec: "deny"` and has a UI oracle built only from `ui`, `input`, `screen` and `apps` calls.
- The suite README shows how wide the paired-difference interval is at round 1's per-task agreement: about ±15 points for the suite's 38 tasks, so a 5-point difference between two models is not visible below about 300 tasks.
