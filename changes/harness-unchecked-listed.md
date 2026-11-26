---
packages: @parcha/agentrun-serve
kind: fix
---
A recipe the server is started with (`--harness-recipe`) is now always in `GET /v2/capabilities`. Until it is installed, checked and has its keys or sign-in, its offer says `available: false` and its `reason` holds the code (`HARNESS_NOT_INSTALLED`, `HARNESS_NOT_CHECKED`, `HARNESS_KEYS_NOT_SAVED` or `HARNESS_NOT_SIGNED_IN`) and the command that fixes it. Before, it was left out of the list, so the console showed nothing to say why it was missing. A definition naming it still saves with a warning, and its run is refused with the same reason, as before.
