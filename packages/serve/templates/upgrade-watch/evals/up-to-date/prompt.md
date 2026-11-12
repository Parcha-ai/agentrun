---
description: The owner already runs the newest release. The report says up to date in two lines, reads no notes and reports nothing from older releases.
runs: 3
max_cost_usd: 0.50
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
- `widget serve --port` is removed. Use `--listen host:port`.

## v2.4.0 (2026-10-20)

### Changed
- `widget export` writes JSON Lines by default. Pass `--format csv` for the previous CSV output.
