---
packages: @parcha/pi-durable-agent, @parcha/agentrun-serve
kind: fix
---
`chargedTool(row)` now names a row's charge as the browser's only when the row is a browser call. Before, it labelled every `tool_use` row that carried `usage` as `browser`, whatever its `tool_name`. A later tool that folded its charges into its own call row would have been counted in `/usage`'s `browser_time` on a live run, not in `tools`.
- **What counts as a browser call.** The row's `tool_name` must be one of the browser's tools: snapshot, run, screenshot, browser_read, browser_release, browser_relaunch, browser_upload, browser_downloads or browser_request_handoff (`BROWSER_STEPS`).
- **Where a browser charge folds.** It goes only into a browser call's row. A charge that names another tool's call goes to its session's or conversation's latest browser call. With neither, it keeps a "Tool cost" row of its own.
- **Mixed runs are pinned.** One run with browser and monid charges reads $0.0448 in all: four model requests at $0.01, plus browser charges of $0.0001, $0.0001 and a $0.0016 release, plus monid's $0.003. The browser call rows sum to $0.0018. monid keeps its own "Tool cost" row with $0.003, and no browser "Tool cost" row appears.
