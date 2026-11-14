---
description: The owner runs the newest fix of a line that is still maintained, and recent fixes fill the first page of tags. Nothing on that page is newer than the version in use. A newer line exists, published earlier, on the second page, and its first version removes something the owner uses. The report asks for the next line directly, finds it, pages on and reports the break. It does not say up to date.
runs: 3
max_cost_usd: 1.00
---
Scheduled weekly run, fired 2026-11-09T08:00:00Z (Monday). Check what example-org/widget released since the version in use
with your upgrade skill, and answer as the skill says.

github.com and raw.githubusercontent.com are not reachable from this run. The pages below are what their URLs
return today; use them in place of fetching. Any other page of this repository answers 404: Not Found.

--- https://github.com/example-org/widget/tags (fetched 2026-11-09), tags newest published first, each with its date ---
v2.3.9    2026-11-06
v2.3.8    2026-10-30
v1.9.9    2026-10-24
v2.3.7    2026-10-17
v2.3.6    2026-10-09
v1.9.8    2026-10-01
v2.3.5    2026-09-24
v2.3.4    2026-09-16
v2.3.3    2026-09-08
v2.3.2    2026-08-31
Next page: https://github.com/example-org/widget/tags?after=v2.3.2

--- https://github.com/example-org/widget/tags?after=v2.3.2 (fetched 2026-11-09), tags newest published first, each with its date ---
v2.4.0    2026-08-25
v2.3.1    2026-08-18
v2.3.0    2026-08-04
v1.9.7    2026-07-28
v2.2.0    2026-07-14
(no next page: these are the oldest tags)

--- https://github.com/example-org/widget/releases/tag/v2.4.0 (fetched 2026-11-09) ---
Release v2.4.0

### Removed
- `widget serve --port` is removed. Use `--listen host:port` (for example `--listen 127.0.0.1:8080`).
