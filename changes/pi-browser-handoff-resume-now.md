---
packages: @parcha/pi-browser
kind: fix
---
A hand-back now resumes the agent within half a second. While a browser hand-over waits on the person, its answer is asked for every 500 ms (`HANDOFF_POLL_MS`), not on the backoff for failed calls, which waited up to 30 s between asks: an agent handed back 40 s into its ask resumed only at 61.5 s. A read of the answer that fails still backs off.
