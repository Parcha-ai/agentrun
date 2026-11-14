---
description: The project publishes fixes to older lines after newer versions, so its tags are not in version order. A newer version was published before the version in use and sits below it in the list, and the tag at the top belongs to an older line. The report goes by version numbers, finds the break in the version listed below the one in use, and leaves the older line out.
runs: 3
max_cost_usd: 1.00
---
Scheduled weekly run, fired 2026-11-09T08:00:00Z (Monday). Check what example-org/widget released since the version in use
with your upgrade skill, and answer as the skill says.

github.com and raw.githubusercontent.com are not reachable from this run. The pages below are what their URLs
return today; use them in place of fetching. Any other page of this repository answers 404: Not Found.

--- https://github.com/example-org/widget/tags (fetched 2026-11-09), tags newest published first, each with its date ---
v1.9.6    2026-11-07
v2.5.0    2026-11-05
v2.3.2    2026-10-30
v2.3.1    2026-10-02
v2.4.0    2026-09-20
v2.3.0    2026-09-15
v1.9.5    2026-09-01
(no next page: these are the oldest tags)

--- https://github.com/example-org/widget/releases/tag/v2.5.0 (fetched 2026-11-09) ---
Release v2.5.0

### Added
- `widget serve --tls-cert` and `--tls-key` serve over HTTPS.

--- https://github.com/example-org/widget/releases/tag/v2.4.0 (fetched 2026-11-09) ---
Release v2.4.0

### Removed
- `widget serve --port` is removed. Use `--listen host:port` (for example `--listen 127.0.0.1:8080`).

--- https://github.com/example-org/widget/releases/tag/v2.3.2 (fetched 2026-11-09) ---
Release v2.3.2

### Fixed
- `widget serve` logs its data directory at start.

--- https://github.com/example-org/widget/releases/tag/v1.9.6 (fetched 2026-11-09) ---
Release v1.9.6

### Removed
- On the 1.9 line, `POST /v2/agents` is removed. Stay on 1.9.5 or move to 2.x.
