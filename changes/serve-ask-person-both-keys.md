---
packages: @parcha/agentrun-serve
kind: fix
---
On pi-durable 1.2 and later, the model's record of an `ask_person` call was empty: the tool returned its text under `content`, which 1.2 renamed to `output`. It now returns both, so every pi-durable serve takes (1.1 to 1.3) reads it. The released image ships pi-durable 1.1.0 and was not affected; builds from source on 1.2 or 1.3 were.
