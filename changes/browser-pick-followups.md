---
packages: @parcha/agentrun-serve
kind: fix
---
Capabilities name the browser vendor the server picked: `tools[].key` for `browser` is the key row of the vendor picked or resolved (`kernel` where Kernel is picked or resolved, else `browserbase`), so a page links a missing Kernel key to Kernel's row, and `features.browser` is the vendor the browser resolves to (`browserbase` or `kernel`), else `none`.
- A run made before the browser was pickable, opened again while Browserbase's keys are missing, reads its browser unavailable for that launch only: its kept choice stays Browserbase, so keys restored later make its next launch run there. Before, the refusal was kept and no key restored it.
