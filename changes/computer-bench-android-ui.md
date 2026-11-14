---
packages: @parcha/agentrun-computer-bench
kind: feature
---
computer-bench's Android tasks done in Settings, Clock, Contacts or Files (16 in android-dev, 6 in mobileworld) deny the agent `exec`, and their oracles do the task through the UI (`ui.act` finds, `apps.launch`, `input.actions`) instead of the shell. Each was verified on the phone-harness cloud phone on seeds 1 to 3: the untouched phone fails its checks and the oracle's passes them.
- The answer tasks device-name, battery-level and alarm-time have an oracle now: it brings the answer on screen and ends with an `expect` on its text.
- A test holds every exec-deny oracle to the ui, input, screen and apps methods.
- The Chrome tasks, take-selfie and check-invoice-1 keep `exec`: the cloud phone has no Chrome, camera or PDF viewer. The READMEs say what the UI oracles lean on in that phone's image.
