---
description: The newest release removes a flag the owner uses and an earlier one changes a default the owner relies on. The report says changes needed, names both items in the owner's words, quotes the notes and gives the notes' own migration step.
runs: 3
max_cost_usd: 1.00
---
Scheduled weekly run, fired 2026-11-09T08:00:00Z (Monday). Check what example-org/widget released since the version in use
with your upgrade skill, and answer as the skill says.

github.com, api.github.com and raw.githubusercontent.com are not reachable from this run. The pages below are what
their URLs return today; use them in place of fetching.

--- https://api.github.com/repos/example-org/widget/releases/latest (fetched 2026-11-09) ---
{ "tag_name": "v2.5.0", "name": "v2.5.0", "prerelease": false, "published_at": "2026-11-05T10:12:00Z" }

--- https://raw.githubusercontent.com/example-org/widget/v2.5.0/CHANGELOG.md (fetched 2026-11-09) ---
# Changelog

## v2.5.0 (2026-11-05)

### Removed
- `widget serve --port` is removed. Use `--listen host:port` (for example `--listen 127.0.0.1:8080`).

### Added
- `widget serve --tls-cert` and `--tls-key` serve over HTTPS.

## v2.4.0 (2026-10-20)

### Changed
- `widget export` writes JSON Lines by default. Pass `--format csv` for the previous CSV output.

### Deprecated
- `WIDGET_TOKEN` is deprecated in favor of `WIDGET_API_KEY` and will be removed in v3.0.0. Both are read for now.

### Fixed
- `widget serve` logs its data directory at start.

## v2.3.1 (2026-10-02)

### Fixed
- `widget serve` no longer exits when its data directory is on a read-only volume.
