---
packages: @parcha/pi-durable-agent, @parcha/agentrun-serve
kind: fix
---
A browser call now counts once among a run's paid tool calls. A run with one browser call read "… and 2 paid tool calls" in its usage row. The browser session's release books a charge of its own under the session's last call, and the count was of charges, not calls.
- **The usage row counts calls.** Paid tool calls are counted by `call`. A call's own charge and its session's release are one paid tool call, so one browser call reads "1 paid tool call" and two read "2 paid tool calls".
- **A charge with no call.** A browser charge that names no call (a release a reopened process made) is its session's last charged call. A charge that cannot be placed at all is a call of its own, as before.
- **Unknown prices count once per call.** A call whose charges have no price is one charge not priced (`unpriced`), however many charges it booked.
- **What doesn't change.** The cost still counts every charge. monid's and Parallel's calls book one charge each, so their counts stay the same.
