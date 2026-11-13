---
description: The newest version removes a flag the owner uses and an earlier one changes a default the owner relies on. The report says changes needed, names both items in the owner's words, quotes the notes and gives the notes' own migration step.
runs: 3
max_cost_usd: 1.00
---
Scheduled weekly run, fired 2026-11-09T08:00:00Z (Monday). Check what example-org/widget released since the version in use
with your upgrade skill, and answer as the skill says.

github.com and raw.githubusercontent.com are not reachable from this run. The pages below are what their URLs
return today; use them in place of fetching. Any other page of this repository answers 404: Not Found.

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

### Added
- `widget serve --tls-cert` and `--tls-key` serve over HTTPS.

--- https://github.com/example-org/widget/releases/tag/v2.4.0 (fetched 2026-11-09) ---
Release v2.4.0

### Changed
- `widget export` writes JSON Lines by default. Pass `--format csv` for the previous CSV output.

### Deprecated
- `WIDGET_TOKEN` is deprecated in favor of `WIDGET_API_KEY` and will be removed in v3.0.0. Both are read for now.

### Fixed
- `widget serve` logs its data directory at start.
