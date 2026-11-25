---
packages: @parcha/agentrun-computer, @parcha/agentrun-serve
kind: feature
---
Agent37 needs only `AGENT37_API_KEY`. The server makes its own Ed25519 SSH key on first use, seals it in its store as it seals every saved key (the row `computer.agent37.ssh_key`, under `AGENTRUN_SEAL_KEY`), and registers its public half on the workspace (`POST /v1/ssh-keys`, named `agentrun-<hash>`) before its first instance, so the instance has it from boot. The one key serves every instance and outlives a restart on the same store. Before, a server took Agent37 only with `AGENT37_SSH_KEY` set to a key you made and registered yourself.
- `AGENT37_SSH_KEY` is now optional. When set, it is used as before, and nothing is made, stored or registered.
- A workspace that already holds Agent37's 20 SSH keys is refused before any instance, code `limit`, in words that name the cap and the way out: delete keys the workspace no longer needs (`agentrun-…` keys are ones AgentRun registered), or set `AGENT37_SSH_KEY`. No key is deleted.
- An instance made before the key was registered is tried again for up to three minutes after the registration (Agent37 hands a key to running instances within about two), within each call's own time. Past that the call is `denied`, and its words name the instance, the key's fingerprint and when it was registered.
- With no seal key, the server keeps its key in memory and registers one key for each process. The conformance module does the same, so `COMPUTER_AGENT37_SSH_KEY` is optional. A key made that way stays on the workspace and counts toward the 20.
- The registration is a note naming the key by its fingerprint. The private key appears in no call, note, error or log.
- For callers of the package: a descriptor may declare `secrets: { option }`, the store (`ProviderSecrets`, `get` and `put`) where a provider keeps secrets it makes for itself. Serve passes its sealed store. Given no store, Agent37's provider keeps its key in the process's memory.
