---
description: The repository's highest tag is a beta of the next major version. The owner runs a final release. The newest version for them is the highest final release, and the beta's notes are not what the verdict is about.
runs: 3
max_cost_usd: 1.00
---
Scheduled weekly run, fired 2026-11-09T08:00:00Z (Monday). Check what example-org/widget released since the version in use
with your upgrade skill, and answer as the skill says.

github.com and raw.githubusercontent.com are not reachable from this run. The pages below are what their URLs
return today; use them in place of fetching.

--- https://github.com/example-org/widget/tags (fetched 2026-11-09), tags newest published first, each with its date ---
v3.0.0-beta.1    2026-11-07
v2.5.0    2026-11-05
v2.4.0    2026-10-20
v2.3.1    2026-10-02
(no next page: these are the oldest tags)

--- https://github.com/example-org/widget/releases/tag/v2.5.0 (fetched 2026-11-09) ---
Release v2.5.0

### Added
- `widget serve --tls-cert` and `--tls-key` serve over HTTPS.

--- https://github.com/example-org/widget/releases/tag/v3.0.0-beta.1 (fetched 2026-11-09) ---
Release v3.0.0-beta.1

### Removed
- `widget serve --port` is removed. Use `--listen host:port` (for example `--listen 127.0.0.1:8080`).
