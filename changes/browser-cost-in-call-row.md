---
packages: @parcha/pi-durable-agent, @parcha/agentrun-serve
kind: feature
---
A browser charge now shows on the browser call's own row, not on a "Tool cost" row of its own. Before, every browser call added a row like "Tool cost: browserbase charged $0.0002 for browser", and the session's release added another, all for fractions of a cent that Usage already counts.
- **The call's row carries it.** The browser call's `tool_use` row has `usage: {"usd": 0.0017, "requests": 0}`: every charge booked under that call, summed. Once one of them has no price, it reads `{"usd": null, "requests": 0, "so_far_usd": ..., "unpriced": ...}`. A browser charge makes no row of its own.
- **A release lands on the last call.** The release's charge is booked under the session's last call, so it lands on that call's row. A charge that names no call (a session a reopened process released) goes to the last call charged for its session, else to its conversation's latest browser call.
- **Live, it is an update.** A charge booked after the answer is served on `/v2` as a change of that row, with the same `id` and the new `usage`. The live reducer re-emits the row.
- **Totals do not change.** The run's cost, its usage row ("... and 3 paid tool calls") and `/usage` count each charge once, as before. On a live run, `/usage` reads `browser_time` from these rows; for an ended run it reads the store, as before.
- **Other tools' charges are unchanged.** monid's and Parallel's web_search keep their own "Tool cost" row.
- **pi-durable-agent** exports `BROWSER_CHARGE` and `chargedTool(row)`. `chargedTool` names the tool whose charge a row carries. The text view shows a call's charge on its line ("Read the page "Example" · $0.0017").
- **OpenAPI** notes on `TimelineRow.usage` where it shows here. The shape stays the contract's `TimelineUsage`.
