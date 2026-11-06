---
packages: @parcha/agentrun-serve
kind: fix
---
A key a tool needs and this server doesn't hold is named where a person fixes it, Settings first: "The tool monid.discover needs a Monid key: save one in Settings → Tool keys (or set MONID_API_KEY where the server starts)." It used to say only that the server's environment did not set MONID_API_KEY, which sent a person who had saved and removed the key in Settings to the wrong place. The same words cover every key Settings saves (Parallel, Monid, Browserbase, Kernel, TypeSafe (Jev), and the model keys): the save's warning, the run's 409, the tools view, capabilities' `reason` and `why` (a vendor picked without its key included), web_fetch's and web_search's answers, and a workflow's decision providers. A variable no key saves (AGENT_MODEL_API_KEY with AGENT_MODEL_BASE_URL) still names only where the server starts. The structured fields (`missing`, `host`) and the plane's stored values are unchanged.
