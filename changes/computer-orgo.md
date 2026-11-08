---
packages: @parcha/agentrun-computer
kind: feature
---
An Orgo desktop provider (`orgo` in the registry, offered for the desktop kind): `create({ apiKey, workspaceId })` makes Linux desktops on Orgo with computerd inside, on Orgo's own X display, so a desktop speaks the same protocol as every computer. Serve passes `apiKey` from `ORGO_API_KEY`; `fromEnv` reads `COMPUTER_ORGO_API_KEY`, `COMPUTER_ORGO_WORKSPACE` and `COMPUTER_ORGO_API_URL` alone.
- It declares a Linux desktop (exec, files, processes, screen, input.pointer, input.keys), daemon child, network `"none"` read back by the probe from inside (Orgo has no egress control, so the tools' isolation is init's own network namespace), Orgo's lifetime (`ends_in_hours`, whole hours, after which Orgo deletes the computer; init holds the exact deadline), release `delete`, `extend`, and no mount yet.
- Each deployment's computers live in one Orgo workspace. A computer's name, `computer-<12 hex>-r<the run's hash>-e<the epoch>`, lets `list` and the takeover filter by run and epoch with nothing run inside; every label and the deadline are in the root-owned `/opt/agentrun/labels.json`, which `attach` reads as the truth.
- `create` refuses, and deletes, a computer whose daemon's sha256 differs, whose X server has no path socket (`/tmp/.X11-unix/X99`: the tools' network namespace cuts the abstract one), whose daemon drifts, or whose probe reaches an address.
- Everything inside a computer goes through an `OrgoChannel` (`run`, `start`, `stdio`, `upload`); the default is Orgo's bash and upload calls and its root terminal WebSocket, made raw, so SSH can replace it. The key is only in the Authorization header, and the VNC password only in the terminal socket's URL.
- The conformance module (`--provider orgo`) runs behind `AGENTRUN_COMPUTER_LIVE_ORGO=1`, with every computer capped at 1 h.
