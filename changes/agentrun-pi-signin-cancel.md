---
packages: @parcha/agentrun-pi
kind: fix
---
`resolveModel`'s `signal` now reaches a first-time sign-in. Cancelling model setup during the sign-in ends it at once: `resolveModel` rejects with the signal's reason, and pi-ai's callback server lets go of port 1455. Before, the sign-in kept waiting for the browser with the port held, so the next sign-in in that process failed with "Port 1455 is in use". A cancel also ends the sign-in when the interaction's prompt does not watch its own signal.
