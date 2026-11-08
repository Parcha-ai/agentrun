---
packages: @parcha/agentrun-kernel, @parcha/agentrun-serve
kind: feature
---
A run's tools follow its computer's kind. A desktop adds `desktop_screen` and `desktop_input`, a phone adds `phone_screen`, `phone_tap`, `phone_swipe`, `phone_type`, `phone_apps` and `phone_open`, and a browser adds pi-browser's browser tools, each after the file and shell tools. The run's folder is mounted in the computer only when the kind has files and exec and its provider mounts the folder: a sandbox always, a desktop when its provider does. Otherwise bash runs in the run's folder on the runner, asking first. Screenshots come back as images.
At the claim, the agent's computer setting is checked against the server's mode and the provider's saved keys. Mode 1 runs a sandbox only on Docker, Mode 2 refuses Docker's sandbox, and a desktop, a phone or a browser is allowed in both. A provider with a required key missing is refused in words that name Settings → Computers. The background tools' refusal with no computer now names the setting too.
