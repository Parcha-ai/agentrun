---
packages: @parcha/agentrun-computer, @parcha/agentrun-serve
kind: breaking
---
An attached Mac no longer offers exec, files or screen unless its owner grants them: Computerd's connection to the server it is paired with offers no `exec` or `files` group, says the new `screen.capture` feature is off, and refuses every `exec.run`, `files.*`, `tar.*` and `screen.*` call in words saying who can switch it on and where. The owner grants them in `~/Library/Application Support/Computerd/policy.json`, as `{"server": ["exec", "files", "screen"]}` (`files` covers tar). A stdio connection (the app's socket, over SSH or a local harness) offers them as before.

A run whose agent's computer is a sandbox on a paired computer is refused before it starts saying to give the agent that computer as the kind it serves (a desktop), no longer to update its driver.
