---
packages: @parcha/agentrun, @parcha/agentrun-serve
kind: fix
---

`install.sh --vps` waits for apt's locks under one deadline: 600 s from the first refusal of a lock other than dpkg's, which each later try's own wait for dpkg's lock is cut to as well, so the whole wait stays under about 1200 s and a first try that waited long for dpkg's lock still leaves its retries. The clock is the time since boot, which a just-booted server's clock steps don't move. A server refused by an earlier version's data now names the command that started it, as the launcher says, never what the folder holds:
- started by the installer's command from the folder refused: move the folder aside, then run the installer again for this same version (`curl -fsSL https://agentrun.ai/install | sh -s -- --version <this version>`), with no npx command that may not be there;
- started by the installer's command on a `--data` of the person's own: move it aside, then that command (`agentrun`, or its path when its folder is not on PATH) with the same `--data`, not npx;
- started by npx: the npx command, even when the folder still holds an earlier install's `bin/agentrun`.

Each says how the earlier version opens the folder moved aside.
