---
description: Two versions since the one in use. Their notes add features, fix bugs and make one breaking change, to a command that is not on the owner's list. The report says safe, lists that change apart, and invents no finding.
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

### Fixed
- `widget stats` no longer counts a cancelled run twice.

--- https://github.com/example-org/widget/releases/tag/v2.4.0 (fetched 2026-11-09) ---
Release v2.4.0

### Breaking
- `widget import` reads YAML only. JSON input is refused with exit code 2; convert with `widget convert`.

### Added
- `POST /v2/agents` accepts an optional `labels` object. Requests without it behave as before.
