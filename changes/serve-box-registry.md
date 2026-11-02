---
packages: @parcha/agentrun-serve
kind: feature
---
The server sets up the boxes `AGENTRUN_BOXES` lists and probes each once at start, all at once and each within 5 s. The boxes are `docker`, `daytona` and the VM provider's, and `bwrap` comes later. Every box is available or not, with a short reason that holds no key, and one `event=boxes` log line says which. A box the list does not name is never probed, and a name that is no box refuses the start. No run uses a box yet. The boxes come from `@parcha/pi-transport`, now an optional peer, and the VM provider's SDK is the host's to install.
- Fixed: a box key set in the server's environment reached every run's process. The launcher now holds these keys with its other secrets (`DAYTONA_API_KEY`, `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`), and no run's process is handed one, in its environment or on its pipe.
