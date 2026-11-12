---
description: Two releases since the version in use. Their notes add features, fix bugs and make one breaking change, to a command that is not on the owner's list. The report says safe, lists that change apart, and invents no finding.
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

### Added
- `widget serve --tls-cert` and `--tls-key` serve over HTTPS.
- `GET /v2/agents/{id}/stats` returns an agent's run counts.

### Fixed
- `widget export` no longer drops the last row of a CSV when the data ends without a newline.

## v2.4.0 (2026-10-20)

### Breaking
- `widget import` reads YAML only. JSON input is refused with exit code 2; convert with `widget convert`.

### Added
- `POST /v2/agents` accepts an optional `labels` object. Requests without it behave as before.

## v2.3.1 (2026-10-02)

### Fixed
- `widget serve` no longer exits when its data directory is on a read-only volume.

## v2.3.0 (2026-09-15)

### Breaking
- `WIDGET_TOKEN` must be at least 32 characters.
