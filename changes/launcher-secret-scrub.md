---
packages: @parcha/agentrun-serve
kind: fix
---
The launcher (`agentrun-serve`) now takes `ARCHIL_API_KEY`, `E2B_API_KEY`, `ORGO_API_KEY`, `PHONE_HARNESS_API_KEY`, `AGENT37_API_KEY` and `AGENT37_SSH_KEY` out of the server's environment and hands them over its pipe, as it already did for Daytona's and Modal's keys. Before, each one set where the server started stayed in the server's own environment (`/proc/<pid>/environ`), where any process of the same user could read it and any child the server spawned with `process.env` inherited it.
- Archil's settings, the server's view of a run's files and Settings → Computers now read a key set where the server starts from the secrets the server holds, not from `process.env`. Before, they read `process.env`, so Settings → Computers showed Daytona's, Modal's, Browserbase's and Kernel's keys, set where the server started, as not set by the environment, and its test used only a saved key.
- No run is handed one of these keys. The runner's claim still reads them, and the Archil claim mints each run's own mount credential from the account key.
- `AGENT37_SSH_KEY` is a private key. An RSA key can take the secrets past the 4,096 bytes the launcher's pipe holds, and then the launcher refuses to start. Save that key in Settings → Computers instead, or use an Ed25519 key.
