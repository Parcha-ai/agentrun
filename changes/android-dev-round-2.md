---
packages: @parcha/agentrun-computer-bench
kind: feature
---
`android-dev` gets 17 new tasks, eight dev and nine heldout, each verified on a cloud phone: the untouched state fails and the oracle's state passes on seeds 1-3. They cover Settings, Clock (timer, alarm repeat days), Contacts (favourites, delete, a labelled email, reading a work number, counting favourites), Files (a nested folder, deleting PDFs, the largest file) and two cross-app tasks. Each one sets `exec: "deny"` and has a UI oracle built only from `ui`, `input`, `screen` and `apps` calls.
- Every exec-deny phone oracle in android-dev and mobileworld first waits for its app's window with an act aimed at the app, then for the text its first find needs: `am start -W` and `apps.launch` can answer on the splash screen, or before the window reaches the accessibility tree. The suite's test holds every oracle to it.
- The suite README shows how wide the paired-difference interval is at round 1's per-task agreement: about ±15 points for the suite's 37 tasks, so a 5-point difference between two models is not visible below about 300 tasks.
- Breaking: `mobileworld.adjust-brightness-max` and `mobileworld.adjust-brightness-min` are removed; no oracle can wait for SystemUI's brightness dialog on the cloud phone (PORT.md, Dropped).
