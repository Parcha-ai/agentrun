---
packages: @parcha/agentrun-serve, @parcha/agentrun-harness-claude, @parcha/agentrun-kernel
kind: fix
---
More follow-ups to Claude Code's login on this machine, and to the server's probe of the harness offers.
- A tool key's save or delete while the offers held are behind the inputs, and the probe out was made from the inputs read now (a turn-on of the login, say), waits until that probe lands or a later one overtakes it, and starts no probe. Before, it started a probe that dropped the one out, so the save answered only after a whole probe of its own. The server logs `harness_offers_wait` as it waits.
- A probe of the offers that fails leaves no probe out when it was the latest one, so a later change back to the inputs the offers held were made from reuses them. Before, that change probed again.
- The "No model yet" bar is gone while the login is on and reads signed in and no agent is picked: a Playground with no agents (a new server), one whose agents are still being read, and every page other than the Playground. Before, a Playground with no agents offered ChatGPT or a key though an agent on Claude Agent would run on the login.
- `parentWatched` throws a `RangeError` at the call for a `termGraceMs` the parent-watch shim would refuse (anything but a whole number of ms from 1 to 2^31 - 1), whichever watch is asked for. Before, the shim exited 2 at spawn, which read as the child's own exit.
- The status check reads an answer that is already in the CLI's output when the drain's second ends, though the server's event loop was held up past that second. Before, the loop ran the drain's timer before its reads, and the check read `no_status`.
