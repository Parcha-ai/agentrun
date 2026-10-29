---
packages: @parcha/agentrun-adapters
kind: ci
---
The adapters' tests that need one thing to happen before another wait for it, never for a fixed time. "close() while a request waits for the runner" failed on a loaded runner when reading the credential took longer than the 30 ms it slept: close() came first and the request was refused before it was admitted. It now closes once the runner's hook is entered, with a credential that takes 60 ms, so a timer in its place fails it. The same kind of wait is replaced in the proxy, runner, runner-stop and kernel tests that asserted what had to happen first.
