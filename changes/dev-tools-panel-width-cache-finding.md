---
packages: @parcha/agentrun-serve
kind: fix
---
console: two fixes to the run page's Dev tools tab.
- With a call's panel open, the calls table no longer scrolls sideways. Beside the panel the table showed its time axis and its Size column from a window 1536 px wide, where it had 740 px and needed some 900, so the tab scrolled sideways until the window was some 1700 px wide. The two columns now show by the width the table has: the time axis from 896 px, Size from 1024 px. Where the panel is under the table (a window under 1280 px), a table wider than its box still scrolls in that box, and the tab no longer scrolls sideways with it.
- "A request read nothing from cache" no longer names a subagent's first request. A subagent is a conversation of its own, so its first request reads nothing by design. A request is now compared only with earlier requests of its own conversation. A workflow run's trace does not say which requests share a conversation, so the finding is left out there.
