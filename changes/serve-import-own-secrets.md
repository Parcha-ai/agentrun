---
packages: @parcha/agentrun-serve
kind: fix
---
An import (`agentrun-serve import` and setup's import) now cuts the secrets this server made and keeps out of everything it writes and prints, by their exact values: its API token (`ar_local_...`), its door token, its sign-in secret, and its webhook's signing secret (`whsec_...`) when the seal key opens it. Before, one pasted into a session was imported as it was. Each counts once in "N secrets removed", as the other keys do. Still imported as they are: a key-shaped value this server did not make (a `whsec_` secret from another service) and a run's own door token.
