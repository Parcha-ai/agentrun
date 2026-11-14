---
description: One version in range was tagged but never published as a release, so it has no release page. Its notes are in the changelog, and they remove something the owner uses. The report falls back to the changelog for that version and finds it.
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

### Added
- `widget serve --tls-cert` and `--tls-key` serve over HTTPS.

--- https://github.com/example-org/widget/releases/tag/v2.4.0 (fetched 2026-11-09) ---
v2.4.0

A tag with no release: the page shows the tag, its commit and its source archives, and no notes.

--- https://raw.githubusercontent.com/example-org/widget/v2.5.0/CHANGELOG.md (fetched 2026-11-09), the whole file ---
# Changelog

## v2.5.0 (2026-11-05)

### Added
- `widget serve --tls-cert` and `--tls-key` serve over HTTPS.

## v2.4.0 (2026-10-20)

### Removed
- `widget serve --port` is removed. Use `--listen host:port` (for example `--listen 127.0.0.1:8080`).

## v2.3.1 (2026-10-02)

### Fixed
- `widget serve` no longer exits when its data directory is on a read-only volume.
