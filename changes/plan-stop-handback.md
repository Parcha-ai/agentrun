---
packages: @parcha/agentrun-serve
kind: fix
---
A run whose ChatGPT token needs renewing after its runner has stopped serving renewals (4 s into the runner's stop) is now handed back to resume on the next start instead of ending failed. Before, its next model request got `credential_unavailable` and the run failed, though no refresh was sent and the sign-in stayed saved. While a server or runner stops, a token that will still be valid when the stop ends (its remaining drain plus 25 s) is sent as it is, with no refresh, so most runs never need the hand-back. A runner's close now drains renewals and closes its store even when a step before them throws. A second stop signal while a runner closes (a second `docker stop`, a double Ctrl-C) no longer ends it at once mid-close: it says once that it is already stopping.
