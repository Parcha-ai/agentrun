---
description: The version in use is real but old, and the tag pages that would reach it cannot be read. Fixes to an even older line sit on the first page, so tags older than the version in use were seen. That does not make the version in use a typo. Its own page exists. The report says incomplete, keeps current_found true, and still reports the break it found in the newer versions it could list.
runs: 3
max_cost_usd: 1.00
---
Scheduled weekly run, fired 2026-11-09T08:00:00Z (Monday). Check what example-org/widget released since the version in use
with your upgrade skill, and answer as the skill says.

github.com and raw.githubusercontent.com are not reachable from this run. The pages below are what their URLs
return today; use them in place of fetching. Any other page of this repository answers 404: Not Found.

--- https://github.com/example-org/widget/tags (fetched 2026-11-09), tags newest published first, each with its date ---
v2.5.0    2026-11-05
v1.9.9    2026-11-01
v2.4.1    2026-10-27
v2.4.0    2026-10-20
v1.9.8    2026-10-12
v2.3.1    2026-10-02
v2.3.0    2026-09-15
v1.9.7    2026-09-05
v2.2.0    2026-08-30
v2.1.2    2026-08-12
Next page: https://github.com/example-org/widget/tags?after=v2.1.2

--- https://github.com/example-org/widget/tags?after=v2.1.2 (fetched 2026-11-09) ---
429: Too Many Requests

--- https://github.com/example-org/widget/releases/tag/v2.0.0 (fetched 2026-11-09) ---
Release v2.0.0

### Removed
- `widget serve --data` no longer accepts a relative path.

--- https://github.com/example-org/widget/releases/tag/v2.5.0 (fetched 2026-11-09) ---
Release v2.5.0

### Removed
- `widget serve --port` is removed. Use `--listen host:port` (for example `--listen 127.0.0.1:8080`).

--- https://github.com/example-org/widget/releases/tag/v2.4.1 (fetched 2026-11-09) ---
Release v2.4.1

### Fixed
- `widget serve` logs its data directory at start.

--- https://github.com/example-org/widget/releases/tag/v2.4.0 (fetched 2026-11-09) ---
Release v2.4.0

### Added
- `POST /v2/agents` accepts an optional `labels` object. Requests without it behave as before.

--- https://github.com/example-org/widget/releases/tag/v2.3.1 (fetched 2026-11-09) ---
Release v2.3.1

### Fixed
- `widget serve` no longer exits when its data directory is on a read-only volume.

--- https://github.com/example-org/widget/releases/tag/v2.3.0 (fetched 2026-11-09) ---
Release v2.3.0

### Added
- `widget stats` prints run counts.

--- https://github.com/example-org/widget/releases/tag/v2.2.0 (fetched 2026-11-09) ---
Release v2.2.0

### Added
- `GET /v2/agents/{id}/stats` returns an agent's run counts.

--- https://github.com/example-org/widget/releases/tag/v2.1.2 (fetched 2026-11-09) ---
Release v2.1.2

### Fixed
- A crash when the data directory is empty.
