---
packages: @parcha/agentrun-serve
kind: feature
---
A server runs a harness recipe it is started with: `agentrun-serve --harness-recipe FILE` (repeatable, or `AGENTRUN_SERVE_HARNESS_RECIPES`), and `agentrun-serve runner` takes the same flag. The harness is listed, and a run starts, only once a `harness-check` passed on the data directory for that recipe file, binary and tree (`<id>.checked`; else `HARNESS_NOT_CHECKED`); each start digests the binary and tree again. A proxy-billed agent runs on the server's model proxy, a plan-billed one on its owner's sign-in (`HARNESS_NOT_SIGNED_IN`), and a plan-billed recipe with only keys is refused (`HARNESS_KEYS_UNSUPPORTED`). A run's agent reaches beyond loopback only through the server's egress proxy, to the recipe's `model.hosts`. The loader now refuses a key whose name is not shaped as a key (`FOO_CRED`: `RECIPE_KEY_NOT_OWN`).
