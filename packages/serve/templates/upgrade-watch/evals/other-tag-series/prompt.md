---
description: The repository tags two products. Its newest tags are of the other one (a CLI), while the owner already runs the newest version of the series they use. The report says up to date and does not take the other product's tag for a newer version.
runs: 3
max_cost_usd: 0.50
---
Scheduled weekly run, fired 2026-11-09T08:00:00Z (Monday). Check what example-org/widget released since the version in use
with your upgrade skill, and answer as the skill says.

github.com and raw.githubusercontent.com are not reachable from this run. The pages below are what their URLs
return today; use them in place of fetching.

--- https://github.com/example-org/widget/tags (fetched 2026-11-09), tags newest published first, each with its date ---
cli-v1.9.0    2026-11-08
v2.5.0    2026-11-05
cli-v1.8.0    2026-10-28
v2.4.0    2026-10-20
v2.3.1    2026-10-02
(no next page: these are the oldest tags)

--- https://github.com/example-org/widget/releases/tag/cli-v1.9.0 (fetched 2026-11-09) ---
widget-cli 1.9.0

### Removed
- `widget-cli login --port` is removed. Use `--listen`.
