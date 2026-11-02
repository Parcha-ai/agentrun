---
packages: @parcha/pi-durable-agent, @parcha/agentrun-serve, repo
kind: fix
---
A run's tool counts read a call's outcome as its timeline does, and analytics name each tool in plain words. `runMetricsOf` counted a tool error only for an error result, so a refused or failed fetch (a result with `ok: false`) counted as a success while its row read failed. One rule, `callFailed(tool, result)` in the timeline's labels, now decides both. The label registry also keeps a tool's display name (`registerLabel(tool, label, fold?, { name })`, read with `nameOf`), and serve's `GET /v2/stats` sends it as `label` beside each `tools` row's `tool` (`stats/3`). The console shows the label, with the name the tool was called by as its title, so `monid_discover`, the browser's `run`, `browser_release` and `submit` read "Search monid's catalog", "Open or act on a page in the browser", "Release the browser session" and "Submit the answer". monid's tools also get timeline labels of their own.
