---
packages: @parcha/agentrun-serve
kind: fix
---
An import (`agentrun-serve import` and setup's import) now cuts the secrets this server made and keeps out of everything it writes and prints, by their exact values: its API token (`ar_local_...`), its door tokens (the server's and each run's), its sign-in secret, and its webhook's signing secret (`whsec_...`, opened with the seal key). Before, one pasted into a session was imported as it was. Each counts once in "N secrets removed", as the other keys do. A key-shaped value this server did not make (a `whsec_` secret from another service) is still imported as it is.
