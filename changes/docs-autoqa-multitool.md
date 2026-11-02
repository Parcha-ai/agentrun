---
packages: repo
kind: docs
---
`docs/AUTOQA.md`: the kernel's multi-tool check runs alone (`node --test test/harness-multi-tool.test.mjs` from `packages/serve`) now that #1363 is on main, the kernel's journal row names `REQUEST_CONTINUED`, and the known open findings mark three items fixed, each with the check that re-checks it: the claude-agent and codex multi-tool hang (#1363, kernel check 6), the console's New agent refused with 422 for call-only tools (#1357, console check 2), and tool keys listing unbound tools as unlocked (#1356, tool plane check 1).
