---
description: The owner already runs the newest version. The report says up to date in two lines, reads no notes and reports nothing from versions the owner already has.
runs: 3
max_cost_usd: 0.50
---
Scheduled weekly run, fired 2026-11-09T08:00:00Z (Monday). Check what example-org/widget released since the version in use
with your upgrade skill, and answer as the skill says.

github.com and raw.githubusercontent.com are not reachable from this run. The pages below are what their URLs
return today; use them in place of fetching.

--- https://github.com/example-org/widget/tags (fetched 2026-11-09), tags newest published first, each with its date ---
v2.5.0    2026-11-05
v2.4.0    2026-10-20
v2.3.1    2026-10-02
v2.3.0    2026-09-15
v2.2.0    2026-08-30
(no next page: these are the oldest tags)

--- https://github.com/example-org/widget/releases/tag/v2.5.0 (fetched 2026-11-09) ---
Release v2.5.0

### Removed
- `widget serve --port` is removed. Use `--listen host:port` (for example `--listen 127.0.0.1:8080`).
