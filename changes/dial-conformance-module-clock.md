---
packages: @parcha/agentrun-computer, @parcha/agentrun-serve
kind: feature
---
A conformance module may export `conformanceClock` (`{ now(), sleep(ms) }`), the clock its provider's timers run on: the conformance CLI and serve's `scripts/dial-conformance.mjs` run on it, so the deadline case waits out its lifetime on that clock rather than in real time. A module that exports none, every vendor's among them, runs on the wall clock as before. `dial-conformance.mjs` also reads `AGENTRUN_REACH_EVERY_MS`, the ms between its asks of `AGENTRUN_PUBLIC_URL` before a run (unset, 1000 as before; anything but a whole number from 1 is refused in words). Before, a fake host's run sat through the 45 s lifetime in real time, and every run waited at least 2 s for three answers a second apart even on the loopback.
