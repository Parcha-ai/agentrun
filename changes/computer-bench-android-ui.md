---
packages: @parcha/agentrun-computer-bench
kind: feature
---
computer-bench's Android tasks done in Settings, Clock, Contacts or Files (16 in android-dev, 6 in mobileworld) deny the agent `exec`, and their oracles do the task through the UI (`ui.act` finds, `apps.launch`, `input.actions`) instead of the shell. They are written against the phone-harness cloud phone (redroid 15); the bench gives such a task's agent no exec or processes group.
- The answer tasks device-name, battery-level and alarm-time have an oracle now: it brings the answer on screen and ends with an `expect` on its text.
- A test holds every exec-deny oracle to the ui, input, screen and apps methods.
- The Chrome tasks, take-selfie and check-invoice-1 keep `exec`: the cloud phone has no Chrome, camera or PDF viewer. The READMEs say what the UI oracles lean on in that phone's image.
