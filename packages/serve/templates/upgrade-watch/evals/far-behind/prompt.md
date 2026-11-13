---
description: The owner is eleven versions behind, so the tags run over two pages. Ten versions touch nothing on the owner's list. The eleventh, on the second page of tags and the last before the version in use, removes something the owner uses. The report pages on, accounts for all eleven and finds it.
runs: 3
max_cost_usd: 1.00
---
Scheduled weekly run, fired 2026-11-09T08:00:00Z (Monday). Check what example-org/widget released since the version in use
with your upgrade skill, and answer as the skill says.

github.com and raw.githubusercontent.com are not reachable from this run. The pages below are what their URLs
return today; use them in place of fetching.

--- https://github.com/example-org/widget/tags (fetched 2026-11-09), tags newest published first, each with its date ---
v2.5.0    2026-11-05
v2.4.1    2026-10-27
v2.4.0    2026-10-20
v2.3.1    2026-10-02
v2.3.0    2026-09-15
v2.2.0    2026-08-30
v2.1.2    2026-08-12
v2.1.1    2026-08-03
v2.1.0    2026-07-21
v2.0.1    2026-07-08
Next page: https://github.com/example-org/widget/tags?after=v2.0.1

--- https://github.com/example-org/widget/tags?after=v2.0.1 (fetched 2026-11-09), tags newest published first, each with its date ---
v2.0.0    2026-06-30
v1.9.0    2026-06-02
v1.8.0    2026-05-11
(no next page: these are the oldest tags)

--- https://github.com/example-org/widget/releases/tag/v2.5.0 (fetched 2026-11-09) ---
Release v2.5.0

### Added
- `widget serve --tls-cert` and `--tls-key` serve over HTTPS.

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

--- https://github.com/example-org/widget/releases/tag/v2.1.1 (fetched 2026-11-09) ---
Release v2.1.1

### Fixed
- `widget stats` no longer counts a cancelled run twice.

--- https://github.com/example-org/widget/releases/tag/v2.1.0 (fetched 2026-11-09) ---
Release v2.1.0

### Added
- `widget serve --log-format json`.

--- https://github.com/example-org/widget/releases/tag/v2.0.1 (fetched 2026-11-09) ---
Release v2.0.1

### Fixed
- A typo in the help text of `widget serve`.

--- https://github.com/example-org/widget/releases/tag/v2.0.0 (fetched 2026-11-09) ---
Release v2.0.0

### Removed
- `WIDGET_TOKEN` is no longer read. Set `WIDGET_API_KEY` to the same value.
