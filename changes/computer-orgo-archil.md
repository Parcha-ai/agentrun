---
packages: @parcha/agentrun-computer
kind: feature
---
Orgo desktops take an Archil mount (`MOUNT` and `PROVIDERS` say `["archil"]`), from the Orgo template `box/build-orgo.mjs` builds: it writes the box recipe as Orgo's install steps (the Dockerfile's archil pins, the helper's bytes checked by sha256, the tool user, no sudo), publishes and builds it with `ORGO_API_KEY`, and prints the ref a spec names as its `image`. The shared Archil steps run as root before init starts, as on Daytona, Modal and E2B; the token reaches the helper's fd 0 through Orgo's root terminal, never a command line.
Nothing runs in an Orgo computer that is not running, since any action wakes a suspended one: `list` reports a stopped Archil computer's mount in words, and `release` deletes it without waking it to check in, saying so through `onNote`. The Orgo conformance module takes run folders (`mountFor("archil")`, the `COMPUTER_ARCHIL_*` settings).
