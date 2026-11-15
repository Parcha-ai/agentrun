---
packages: @parcha/agentrun-serve
kind: fix
---
The bundled code-review package's per-run cap is $2.00, up from $0.50. On its default model where the fast tier is GPT-6.1 Sol (an OpenRouter key alone), the eight reviewers' first requests, each held at its worst case, filled the $0.50 cap within seconds and parked even a five-line review waiting for a higher cap. Measured on that model, a review of a pull request up to about 400 lines cost $0.16 to $0.90, and $2.00 is about twice the dearest. A run on particle-1 (the `particle` choice) still costs a few cents.
