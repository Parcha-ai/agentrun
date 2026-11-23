---
packages: @parcha/agentrun-serve
kind: fix
---
A key a run brings in `keys` or `model_key` is now visible ASCII alone (`!` to `~`, no space), as a header carries it. In 0.1.0-beta.53 a key with a character past ASCII was taken, and one of 4 characters outside the 16-bit range (8 UTF-16 units) passed the 8-character floor though the cut, which counts characters, never cut it from what the run writes. Such a key is now 422 `invalid` at `keys.<NAME>` or `model_key`, the value never echoed.
